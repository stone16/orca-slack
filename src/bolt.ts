import { App, LogLevel, SocketModeReceiver, type BlockAction, type Logger } from '@slack/bolt';
import type { Orca } from './orca.js';
import { Bridge, type Action, type SlackEvent } from './slack.js';
import { Store, type SlackCard } from './store.js';
import { renderDecision, renderResult, renderStatus, statusActions,
  type DecisionView, type ResultView, type SlackPost, type StatusView } from './render.js';

export interface SlackClient {
  chat: {
    postMessage(args: SlackPost & { channel: string; thread_ts: string; unfurl_links: boolean; unfurl_media: boolean }): Promise<{ ts?: string }>;
    update(args: SlackPost & { channel: string; ts: string }): Promise<unknown>;
    postEphemeral(args: { channel: string; user: string; text: string }): Promise<unknown>;
  };
  reactions: { add(args: { channel: string; timestamp: string; name: string }): Promise<unknown> };
  views: { open(args: Parameters<App['client']['views']['open']>[0]): Promise<unknown> };
}
export interface AdapterOptions {
  orca: Orca; allowedUsers: readonly string[]; botId: string;
  statusView(threadId: string): StatusView | undefined | Promise<StatusView | undefined>;
  ownerAction(action: Exclude<Action, { actionId: 'log-tail' }>): Promise<void>;
  logTail(threadId: string): Promise<string>;
}
interface Click { actionId: string; value: string; channel: string; user: string; messageTs: string; triggerId: string }

export class SlackAdapter {
  readonly bridge: Bridge;
  private queues = new Map<string, Promise<unknown>>();
  constructor(private slack: SlackClient, private store: Store, private options: AdapterOptions) {
    this.bridge = new Bridge(options.orca, this, store, options.allowedUsers, options.botId);
  }
  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(key, result);
    return result.finally(() => { if (this.queues.get(key) === result) this.queues.delete(key); });
  }
  async refuse(channel: string, user: string): Promise<void> {
    await this.slack.chat.postEphemeral({ channel, user, text: '你没有操作此桥的权限。' });
  }
  async ownerAction(action: Action): Promise<void> {
    if (action.actionId !== 'log-tail') return this.options.ownerAction(action);
    const tail = (await this.options.logTail(action.threadId)).split('\n').slice(-40).join('\n').slice(-3000) || '(empty log)';
    await this.slack.views.open({ trigger_id: action.triggerId, view: { type: 'modal',
      title: { type: 'plain_text', text: '日志尾部' }, close: { type: 'plain_text', text: '关闭' },
      blocks: [{ type: 'section', text: { type: 'plain_text', text: tail } }],
    } });
  }
  private publish<T extends object>(threadId: string, key: string, view: (saved?: SlackCard) => T,
    render: (view: T) => SlackPost): Promise<string> {
    return this.serial(`card:${threadId}:${key}`, async () => {
      const thread = this.store.thread(threadId);
      if (!thread) throw new Error('Unknown Slack thread');
      const saved = this.store.slackCard(threadId, key);
      const current = view(saved);
      const message = render(current);
      let ts = saved?.ts;
      if (ts) await this.slack.chat.update({ channel: thread.channel, ts, ...message });
      else {
        const result = await this.slack.chat.postMessage({ channel: thread.channel, thread_ts: thread.threadTs,
          ...message, unfurl_links: false, unfurl_media: false });
        ts = result.ts;
        if (!ts) throw new Error('Slack returned no message timestamp');
      }
      this.store.saveSlackCard({ threadId, key, ts, view: JSON.stringify(current) });
      return ts;
    });
  }
  status(view: StatusView): Promise<string> {
    return this.publish(view.threadId, 'status', saved => {
      const previous: StatusView | undefined = saved && JSON.parse(saved.view);
      const sameWork = previous?.state === view.state &&
        JSON.stringify(previous.worktrees.map(tree => tree.id)) === JSON.stringify(view.worktrees.map(tree => tree.id));
      return { ...view, acted: view.acted ?? (sameWork ? previous?.acted : undefined) };
    }, renderStatus);
  }
  decision(view: DecisionView): Promise<string> {
    return this.serial(`decision:${view.id}`, async () => {
      const existing = this.store.decision(view.id);
      if (existing && (existing.threadId !== view.threadId || JSON.stringify(existing.options) !== JSON.stringify(view.options))) {
        throw new Error('Decision identity changed');
      }
      const owner = this.store.thread(view.threadId)?.owner;
      if (!owner) throw new Error('Unknown Slack thread');
      const current = { ...view, owner, answer: existing?.answer, answeredBy: existing?.answeredBy };
      const ts = await this.publish(view.threadId, `decision:${view.id}`, () => current, renderDecision);
      if (!existing) this.store.saveDecision({ id: view.id, threadId: view.threadId, options: view.options, slackTs: ts });
      return ts;
    });
  }
  result(view: ResultView): Promise<string> {
    const owner = this.store.thread(view.threadId)?.owner;
    if (!owner) return Promise.reject(new Error('Unknown Slack thread'));
    return this.publish(view.threadId, `result:${view.id}`, saved => ({ ...view, owner,
      retriedBy: saved ? (JSON.parse(saved.view) as ResultView).retriedBy ?? view.retriedBy : view.retriedBy }), renderResult);
  }
  private async refresh(threadId: string, acted?: StatusView['acted']): Promise<void> {
    const view = await this.options.statusView(threadId);
    if (view) await this.status({ ...view, acted });
  }
  private async react(event: SlackEvent, name: 'eyes' | 'white_check_mark'): Promise<void> {
    try { await this.slack.reactions.add({ channel: event.channel, timestamp: event.ts, name }); }
    catch (error) {
      if ((error as { data?: { error?: string } }).data?.error !== 'already_reacted') throw error;
    }
  }
  async event(event: SlackEvent): Promise<void> {
    try { await this.bridge.event(event); }
    finally {
      const thread = this.store.findThread(event.channel, event.threadTs ?? event.ts);
      const saved = thread && this.store.inbound(thread.id).find(message => message.installationId === event.installationId && message.ts === event.ts);
      if (saved && saved.kind !== 'archive' && !event.botMessage && event.user !== this.options.botId &&
          this.options.allowedUsers.includes(event.user)) {
        await this.react(event, 'eyes');
        if (saved.kind === 'prompt' && saved.state === 'forwarded') await this.react(event, 'white_check_mark');
        await this.refresh(thread!.id);
      }
    }
  }
  async action(click: Click): Promise<void> {
    let value: Record<string, unknown>;
    try { value = JSON.parse(click.value); } catch { return; }
    if (!value || typeof value !== 'object' || typeof value.threadId !== 'string') return;
    const threadId = value.threadId;
    await this.serial(`action:${threadId}`, async () => {
      const thread = this.store.thread(threadId);
      if (!thread || thread.channel !== click.channel) return;
      let action: Action;
      const base = { threadId, channel: click.channel, user: click.user };
      let key: string;
      if (/^decision_\d+$/.test(click.actionId)) {
        if (typeof value.decisionId !== 'string' || typeof value.option !== 'string') return;
        const decision = this.store.decision(value.decisionId);
        if (!decision || decision.threadId !== threadId || decision.slackTs !== click.messageTs) return;
        key = `decision:${value.decisionId}`;
        action = { ...base, actionId: 'decision', decisionId: value.decisionId, option: value.option };
      } else if (click.actionId === 'retry' || click.actionId === 'log-tail') {
        if (typeof value.resultId !== 'string') return;
        key = `result:${value.resultId}`;
        const saved = this.store.slackCard(threadId, key);
        if (!saved || saved.ts !== click.messageTs) return;
        const result: ResultView = JSON.parse(saved.view);
        if (result.outcome !== 'failed' || result.retriedBy) return;
        action = click.actionId === 'log-tail' ? { ...base, actionId: 'log-tail', triggerId: click.triggerId }
          : { ...base, actionId: 'retry' };
      } else if (click.actionId === 'stop' || click.actionId === 'cleanup' || click.actionId === 'switch-repository') {
        key = 'status';
        const view = await this.options.statusView(threadId);
        if (!view || !statusActions(view).includes(click.actionId)) return;
        const displayed = this.store.slackCard(threadId, key);
        if (!displayed || !statusActions(JSON.parse(displayed.view)).includes(click.actionId)) return;
        action = { ...base, actionId: click.actionId };
      } else return;
      const saved = this.store.slackCard(threadId, key);
      if (!saved || saved.ts !== click.messageTs) return;
      const accepted = await this.bridge.action(action);
      if (action.actionId === 'decision') {
        const decision = this.store.decision(action.decisionId)!;
        if (decision.answer !== undefined) await this.decision({ ...JSON.parse(saved.view), ...decision, owner: thread.owner });
      }
      if (!accepted) return;
      if (action.actionId === 'retry') {
        const result: ResultView = { ...JSON.parse(saved.view), retriedBy: click.user };
        this.store.saveSlackCard({ ...saved, view: JSON.stringify(result) });
        await this.result(result);
      }
      const acted = action.actionId === 'switch-repository' || action.actionId === 'cleanup'
        ? { actionId: action.actionId, user: click.user } : undefined;
      if (acted) this.store.saveSlackCard({ ...saved, view: JSON.stringify({ ...JSON.parse(saved.view), acted }) });
      if (action.actionId !== 'log-tail') await this.refresh(threadId, acted);
    });
  }
}

export function registerHandlers(app: App, adapter: SlackAdapter): void {
  for (const type of ['message', 'app_mention'] as const) {
    app.event(type, async ({ event, body }) => {
      if (('subtype' in event && event.subtype && !['file_share', 'thread_broadcast'].includes(event.subtype)) ||
          'bot_id' in event || !('user' in event) || !event.user || !('text' in event) || typeof event.text !== 'string' ||
          !('ts' in event) || !event.ts || !('channel' in event) || !event.channel ||
          !body.api_app_id || !(body.team_id || body.enterprise_id) || !body.event_id) return;
      await adapter.event({ installationId: `${body.api_app_id}:${body.team_id || body.enterprise_id}`,
        eventId: body.event_id, channel: event.channel, ts: event.ts,
        threadTs: 'thread_ts' in event ? event.thread_ts : undefined, user: event.user, text: event.text });
    });
  }
  app.action<BlockAction>(/^(decision_\d+|switch-repository|stop|cleanup|retry|log-tail)$/, async ({ ack, action, body }) => {
    await ack();
    if (!('value' in action) || !action.value || !body.channel || !body.message) return;
    await adapter.action({ actionId: action.action_id, value: action.value, channel: body.channel.id,
      user: body.user.id, messageTs: body.message.ts, triggerId: body.trigger_id });
  });
}

export function createSocketMode(store: Store, options: AdapterOptions,
  log: (level: string, message: string) => void = () => {}) {
  const token = process.env.SLACK_BOT_TOKEN, appToken = process.env.SLACK_APP_TOKEN;
  if (!token || !appToken) throw new Error('SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required');
  const redact = (value: unknown): string => {
    let text: string;
    try { text = value instanceof Error ? value.message : typeof value === 'string' ? value : JSON.stringify(value); }
    catch { text = '[unserializable]'; }
    return String(text).replaceAll(token, '[redacted]').replaceAll(appToken, '[redacted]');
  };
  const logger: Logger = {
    debug: (...args) => log('debug', args.map(redact).join(' ')),
    info: (...args) => log('info', args.map(redact).join(' ')),
    warn: (...args) => log('warn', args.map(redact).join(' ')),
    error: (...args) => log('error', args.map(redact).join(' ')),
    setLevel: () => {}, getLevel: () => LogLevel.INFO, setName: () => {},
  };
  const receiver = new SocketModeReceiver({ appToken, logger });
  const app = new App({ token, receiver, logger, botUserId: options.botId, tokenVerificationEnabled: false,
    clientOptions: { retryConfig: { retries: 2 }, timeout: 10_000 } });
  const adapter = new SlackAdapter(app.client, store, options);
  registerHandlers(app, adapter);
  app.error(async error => { logger.error(error); });
  return { app, adapter, socket: receiver.client };
}
