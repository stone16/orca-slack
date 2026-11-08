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
function workKey(view: StatusView): string { return JSON.stringify(view.worktrees.map(tree => tree.id).sort()); }
function operationKey(key: string, action: string, scope = ''): string { return JSON.stringify([key, action, scope]); }

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
    if (action.actionId !== 'log-tail') {
      if (action.operationKey && this.store.slackAction(action.threadId, action.operationKey)) return;
      await this.options.ownerAction(action);
      if (action.operationKey) this.store.saveSlackAction(action.threadId, action.operationKey, action.user);
      return;
    }
    const tail = (await this.options.logTail(action.threadId)).split('\n').slice(-40).join('\n').slice(-3000) || '(empty log)';
    await this.slack.views.open({ trigger_id: action.triggerId, view: { type: 'modal',
      title: { type: 'plain_text', text: '日志尾部' }, close: { type: 'plain_text', text: '关闭' },
      blocks: [{ type: 'section', text: { type: 'plain_text', text: tail } }],
    } });
  }
  private publish<T extends object>(threadId: string, key: string, view: (saved?: SlackCard) => T | Promise<T>,
    render: (view: T) => SlackPost): Promise<string>;
  private publish<T extends object>(threadId: string, key: string,
    view: (saved?: SlackCard) => T | undefined | Promise<T | undefined>, render: (view: T) => SlackPost): Promise<string | undefined>;
  private publish<T extends object>(threadId: string, key: string,
    view: (saved?: SlackCard) => T | undefined | Promise<T | undefined>, render: (view: T) => SlackPost): Promise<string | undefined> {
    return this.serial(`card:${threadId}:${key}`, async () => {
      const thread = this.store.thread(threadId);
      if (!thread) throw new Error('Unknown Slack thread');
      const saved = this.store.slackCard(threadId, key);
      const current = await view(saved);
      if (!current) return;
      const encoded = JSON.stringify(current);
      if (saved?.view === encoded) return saved.ts;
      const message = render(current);
      let ts = saved?.ts;
      if (ts) await this.slack.chat.update({ channel: thread.channel, ts, ...message });
      else {
        const result = await this.slack.chat.postMessage({ channel: thread.channel, thread_ts: thread.threadTs,
          ...message, unfurl_links: false, unfurl_media: false });
        ts = result.ts;
        if (!ts) throw new Error('Slack returned no message timestamp');
      }
      this.store.saveSlackCard({ threadId, key, ts, view: encoded });
      return ts;
    });
  }
  status(view: StatusView): Promise<string> {
    return this.publish(view.threadId, 'status', saved => this.statusView(view, saved), renderStatus);
  }
  private statusView(view: StatusView, saved?: SlackCard): StatusView {
    const previous: StatusView | undefined = saved && JSON.parse(saved.view);
    const sameWork = previous && workKey(previous) === workKey(view);
    const switchedBy = this.store.slackAction(view.threadId, operationKey('status', 'switch-repository', workKey(view)));
    const cleanedBy = this.store.slackAction(view.threadId, operationKey('status', 'cleanup', workKey(view))) ??
      (previous && view.state === 'cleaned'
        ? this.store.slackAction(view.threadId, operationKey('status', 'cleanup', workKey(previous))) : undefined);
    let acted = view.acted;
    if (switchedBy) acted = { actionId: 'switch-repository', user: switchedBy };
    else if (sameWork && previous?.acted?.actionId === 'switch-repository') acted = previous.acted;
    if (['awaiting-verification', 'cleaned'].includes(view.state)) {
      if (cleanedBy) acted = { actionId: 'cleanup', user: cleanedBy };
      else if (previous?.acted?.actionId === 'cleanup' && (sameWork || view.state === 'cleaned')) acted = previous.acted;
    } else if (acted?.actionId === 'cleanup') acted = undefined;
    return { ...view, acted };
  }
  decision(view: DecisionView): Promise<string> {
    return this.serial(`decision:${view.id}`, async () => {
      const existing = this.store.decision(view.id);
      if (existing && (existing.threadId !== view.threadId || JSON.stringify(existing.options) !== JSON.stringify(view.options))) {
        throw new Error('Decision identity changed');
      }
      const ts = await this.publish(view.threadId, `decision:${view.id}`, () => this.decisionView(view), renderDecision);
      if (!existing) this.store.saveDecision({ id: view.id, threadId: view.threadId, options: view.options, slackTs: ts });
      return ts;
    });
  }
  private decisionView(view: DecisionView): DecisionView {
    const owner = this.store.thread(view.threadId)?.owner;
    if (!owner) throw new Error('Unknown Slack thread');
    const current = this.store.decision(view.id);
    return { ...view, owner, answer: current?.answer, answeredBy: current?.answeredBy };
  }
  private refreshDecision(threadId: string, id: string): Promise<string | undefined> {
    return this.publish(threadId, `decision:${id}`, saved => saved && this.decisionView(JSON.parse(saved.view)), renderDecision);
  }
  result(view: ResultView): Promise<string> {
    return this.publish(view.threadId, `result:${view.id}`, saved => this.resultView(view, saved), renderResult);
  }
  private resultView(view: ResultView, saved?: SlackCard): ResultView {
    const owner = this.store.thread(view.threadId)?.owner;
    if (!owner) throw new Error('Unknown Slack thread');
    return { ...view, owner,
      retriedBy: this.store.slackAction(view.threadId, operationKey(`result:${view.id}`, 'retry')) ??
        (saved ? (JSON.parse(saved.view) as ResultView).retriedBy : undefined) ?? view.retriedBy };
  }
  private refreshResult(threadId: string, key: string): Promise<string | undefined> {
    return this.publish(threadId, key, saved => saved && this.resultView(JSON.parse(saved.view), saved), renderResult);
  }
  private async refresh(threadId: string): Promise<void> {
    await this.publish(threadId, 'status', async saved => {
      const view = await this.options.statusView(threadId);
      return view && this.statusView(view, saved);
    }, renderStatus);
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
      if (thread && !event.botMessage && event.user !== this.options.botId && this.options.allowedUsers.includes(event.user)) {
        await this.deliver(thread.id);
      }
    }
  }
  async replay(threadId?: string): Promise<void> {
    try { await this.bridge.replay(threadId); }
    finally { await this.deliver(threadId); }
  }
  private async deliver(threadId?: string): Promise<void> {
    const threads = new Set(this.store.inbound(threadId).filter(message => message.kind !== 'archive').map(message => message.threadId));
    await Promise.all([...threads].map(id => this.serial(`delivery:${id}`, async () => {
      for (const message of this.store.inbound(id)) {
        if (message.kind === 'archive') continue;
        const names: ('eyes' | 'white_check_mark')[] = ['eyes'];
        if (message.kind === 'prompt' && message.state === 'forwarded') names.push('white_check_mark');
        for (const name of names) {
          if (this.store.hasSlackReaction(message.key, name)) continue;
          await this.react(message, name);
          this.store.saveSlackReaction(message.key, name);
        }
      }
      await this.refresh(id);
    })));
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
        if (result.outcome !== 'failed' || (click.actionId === 'retry' && result.retriedBy)) return;
        action = click.actionId === 'log-tail' ? { ...base, actionId: 'log-tail', triggerId: click.triggerId }
          : { ...base, actionId: 'retry', operationKey: operationKey(key, 'retry') };
      } else if (click.actionId === 'stop' || click.actionId === 'cleanup' || click.actionId === 'switch-repository') {
        key = 'status';
        const displayed = this.store.slackCard(threadId, key);
        if (!displayed || displayed.ts !== click.messageTs || !statusActions(JSON.parse(displayed.view)).includes(click.actionId)) return;
        const receiptKey = operationKey(key, click.actionId, workKey(JSON.parse(displayed.view)));
        const view = await this.options.statusView(threadId);
        if (!this.store.slackAction(threadId, receiptKey)) {
          if (!view) return;
          if (workKey(JSON.parse(displayed.view)) !== workKey(view)) { await this.refresh(threadId); return; }
          if (!statusActions(view).includes(click.actionId)) return;
        }
        action = { ...base, actionId: click.actionId, ...(click.actionId === 'stop' ? {} : { operationKey: receiptKey }) };
      } else return;
      const saved = this.store.slackCard(threadId, key);
      if (!saved || saved.ts !== click.messageTs) return;
      const accepted = await this.bridge.action(action);
      if (action.actionId === 'decision') {
        const decision = this.store.decision(action.decisionId)!;
        if (decision.answer !== undefined) await this.refreshDecision(threadId, action.decisionId);
      }
      if (!accepted) return;
      if (action.actionId === 'retry') await this.refreshResult(threadId, key);
      if (action.actionId !== 'log-tail') await this.refresh(threadId);
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
