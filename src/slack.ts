import type { App, BlockAction } from '@slack/bolt';
import type { Config } from './config.js';
import { OrcaError, type Orca, type StartReceipt } from './orca.js';
import { Store, type Thread } from './store.js';
import { route, stripMention } from './route.js';
import { dispatched, post, react, stopped, type Slack } from './render.js';

export interface SlackEvent {
  eventId: string; channel: string; ts: string; threadTs?: string; user?: string;
  text?: string; botId: string; botMessage?: boolean; mention: boolean;
}
export interface Action { actionId: string; value: string; user: string; channel: string; messageTs: string }
export class Bridge {
  private queues = new Map<string, Promise<unknown>>();
  private starts = new Set<Promise<unknown>>();
  constructor(private orca: Orca, private slack: Slack, private store: Store, private config: Config, private runId: string) {}
  recordEvent(id: string): boolean { return this.store.claim(id); }
  async waitForStarts(): Promise<void> { await Promise.allSettled([...this.starts]); }
  private async serial(key: string, work: () => Promise<void>): Promise<void> {
    const pending = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(key, pending);
    try { await pending; } finally { if (this.queues.get(key) === pending) this.queues.delete(key); }
  }
  private async allowed(user: string, channel: string): Promise<boolean> {
    if (this.config.allowedUsers.includes(user)) return true;
    await this.slack.chat.postEphemeral({ channel, user, text: '你没有操作此桥的权限。' });
    return false;
  }
  async event(event: SlackEvent): Promise<void> {
    // shortcut: crash after event claim needs operator inspection, add a durable inbox when automatic recovery is required.
    if (!this.recordEvent(event.eventId)) return;
    if (!event.user || event.botMessage || event.user === event.botId) return;
    const root = event.threadTs ?? event.ts;
    let tracked = this.store.byThread(root);
    if (tracked && tracked.channel !== event.channel) return;
    if (!tracked && (!event.mention || !this.config.channels[event.channel])) return;
    if (!await this.allowed(event.user, event.channel)) return;
    if (!this.store.claim(`message:${event.channel}:${event.ts}`)) return;
    tracked = this.store.byThread(root);
    if (tracked) {
      await this.serial(root, async () => {
        const thread = this.store.byThread(root)!;
        const text = stripMention(event.text ?? '', event.botId);
        if (!text) return;
        if (!thread.dispatch_id) return;
        if (text === '!stop') {
          if (['done', 'stopped'].includes(thread.status)) return;
          await this.stop(thread, event.user!);
          await react(this.slack, event.channel, event.ts, 'white_check_mark');
          return;
        }
        const question = this.store.pendingQuestion(root);
        if (question) await this.answer(thread, question.message_id, text, event.user!);
        else await this.orca.call('send', ['--to', `dispatch:${thread.dispatch_id}`, '--run', this.runId,
          '--type', 'status', '--priority', 'high', '--subject', 'Slack follow-up', '--body', text]);
        await react(this.slack, event.channel, event.ts, 'white_check_mark');
      });
      return;
    }
    let args: string[];
    try { args = route(this.config.channels[event.channel], event.text ?? '', event.botId); }
    catch {
      await this.slack.chat.postEphemeral({ channel: event.channel, user: event.user, text: '请在提及后写任务内容。' });
      return;
    }
    const thread: Thread = { thread_ts: root, channel: event.channel, ts: event.ts, run_id: this.runId, task_id: '', dispatch_id: '',
      worktree: '', repo: this.config.channels[event.channel].repo, requester: event.user, status: 'dispatching' };
    this.store.saveThread(thread);
    // React before any Orca command; Bolt has already acknowledged the event envelope.
    const start = this.serial(root, async () => {
      await react(this.slack, event.channel, event.ts, 'eyes');
      await this.dispatch(thread, event.user!, args);
    });
    this.starts.add(start);
    try { await start; } finally { this.starts.delete(start); }
  }
  private async dispatch(thread: Thread, user: string, args: string[]): Promise<void> {
    let receipt: StartReceipt;
    let errorText: string | undefined;
    try {
      const link = await this.slack.chat.getPermalink({ channel: thread.channel, message_ts: thread.thread_ts });
      if (!link.permalink) throw new Error('Slack did not return a thread permalink');
      args[1] = `Requester: ${user}\nChannel: ${thread.channel}\nThread: ${link.permalink}\nSend worker_done with --outcome; ask with the question type when blocked.\nDo not use interactive question tools (including AskUserQuestion); use orca orchestration ask so Slack can answer.\n\n${args[1]}`;
      receipt = await this.orca.call<StartReceipt>('worker-start', [...args, '--run', this.runId]);
      if (!receipt.dispatchId || !receipt.taskId) throw new OrcaError('Invalid worker-start receipt', receipt);
    } catch (error) {
      receipt = error instanceof OrcaError ? error.receipt : {};
      errorText = error instanceof Error ? error.message : String(error);
    }
    const worktree = receipt.effects?.find(effect => effect.kind === 'worktree')?.id?.replace(/^[^:]+::/, '') ?? '';
    this.store.saveThread({ ...thread, task_id: receipt.taskId ?? '', dispatch_id: receipt.dispatchId ?? '',
      worktree, status: errorText === undefined ? 'running' : 'failed' });
    await post(this.slack, thread.channel, thread.thread_ts, errorText === undefined
      ? dispatched(receipt.dispatchId!, worktree || '(not returned)', this.runId) : { text: `❌ 派发失败：${errorText}` });
  }
  private async answer(thread: Thread, id: string, text: string, user: string): Promise<void> {
    await this.orca.call('reply', ['--id', id, '--body', text, '--run', this.runId]);
    this.store.answerQuestion(id, user);
    const question = this.store.question(id)!;
    if (question.slack_ts) await this.slack.chat.update({ channel: thread.channel, ts: question.slack_ts,
      text: `<@${user}> answered: ${text}`, blocks: [{ type: 'section', text: { type: 'plain_text', text: `${user} answered: ${text}`.slice(0, 3000) } }] });
  }
  private async stop(thread: Thread, user: string): Promise<void> {
    await this.orca.call('worker-stop', ['--dispatch', thread.dispatch_id]);
    await this.orca.call('worker-release', ['--dispatch', thread.dispatch_id]);
    this.store.setStatus(thread.thread_ts, 'stopped');
    await post(this.slack, thread.channel, thread.thread_ts, stopped(user));
  }
  async action(action: Action): Promise<void> {
    if (!await this.allowed(action.user, action.channel)) return;
    let value: { messageId?: string; option?: string; dispatchId?: string };
    try { value = JSON.parse(action.value); } catch { return; }
    if (!value || typeof value !== 'object') return;
    const question = typeof value.messageId === 'string' ? this.store.question(value.messageId) : undefined;
    const thread = action.actionId === 'stop' && typeof value.dispatchId === 'string'
      ? this.store.byDispatch(value.dispatchId) : question ? this.store.byThread(question.thread_ts) : undefined;
    if (!thread || thread.channel !== action.channel) return;
    await this.serial(thread.thread_ts, async () => {
      const current = this.store.byThread(thread.thread_ts)!;
      if (action.actionId === 'stop') {
        if (current.dispatch_id && !['done', 'stopped'].includes(current.status)) await this.stop(current, action.user);
        return;
      }
      if (action.actionId !== 'answer' || !question || question.slack_ts !== action.messageTs ||
          this.store.question(question.message_id)?.answered_at || typeof value.option !== 'string' ||
          !(JSON.parse(question.options_json) as string[]).includes(value.option)) return;
      await this.answer(thread, question.message_id, value.option, action.user);
    });
  }
}
export function registerHandlers(app: App, bridge: Bridge, fatal: (error: unknown) => void): void {
  for (const type of ['app_mention', 'message'] as const) {
    app.event(type, async ({ event, body, context }) => {
      if ((event.type === 'message' && event.subtype && event.subtype !== 'bot_message') ||
          !('ts' in event) || !('channel' in event)) { bridge.recordEvent(body.event_id); return; }
      void bridge.event({ eventId: body.event_id, channel: event.channel, ts: event.ts,
        threadTs: 'thread_ts' in event ? event.thread_ts : undefined,
        user: 'user' in event ? event.user : undefined, text: 'text' in event ? event.text : undefined,
        botId: context.botUserId ?? '', botMessage: 'bot_id' in event, mention: type === 'app_mention',
      }).catch(fatal);
    });
  }
  for (const actionId of ['answer', 'stop']) {
    app.action<BlockAction>(actionId === 'answer' ? /^answer_[0-4]$/ : actionId, async ({ ack, body, action }) => {
      await ack();
      if (!('value' in action) || !body.channel || !body.message) return;
      void bridge.action({ actionId, value: action.value ?? '', user: body.user.id,
        channel: body.channel.id, messageTs: body.message.ts }).catch(fatal);
    });
  }
}
