import type { Leads } from './leads.js';
import type { Orca } from './orca.js';
import { Store, type SlackEvent } from './store.js';
import type { UnboundThreads } from './unbound-threads.js';

export type { SlackEvent } from './store.js';
export type Action = { threadId: string; channel: string; user: string; operationKey?: string } & (
  { actionId: 'decision'; decisionId: string; option: string } |
  { actionId: 'log-tail'; triggerId: string } |
  { actionId: 'retry' | 'cleanup' | 'switch-repository' | 'stop' }
);
export class Bridge {
  private queues = new Map<string, Promise<unknown>>();
  constructor(private orca: Orca,
    private slack: { refuse(channel: string, user: string): Promise<void>; ownerAction(action: Action): Promise<void> },
    private store: Store, private allowedUsers: readonly string[], private botId: string,
    private afterSave: () => void | Promise<void> = () => {}, private leads?: Leads, private unboundThreads?: UnboundThreads) {
    this.unboundThreads?.trackBindings(store);
  }

  async event(event: SlackEvent): Promise<void> {
    if (event.botMessage || event.user === this.botId) return;
    const threadTs = event.threadTs ?? event.ts;
    const existing = this.store.findThread(event.channel, threadTs);
    const mentioned = event.text.includes(`<@${this.botId}>`);
    if (!existing && !mentioned) return;
    if (!this.allowedUsers.includes(event.user)) {
      await this.slack.refuse(event.channel, event.user);
      return;
    }
    const thread = existing ?? { id: JSON.stringify([event.channel, threadTs]), channel: event.channel,
      threadTs, owner: event.user };
    const kind = this.text(event.text) === '!stop' ? 'stop'
      : thread.owner === event.user || mentioned ? 'prompt' : 'archive';
    const saved = this.store.saveInbound(thread, event, kind);
    if (!this.store.worktrees(thread.id).length) this.unboundThreads?.append(thread, event);
    if (saved) await this.afterSave();
    await this.replay(thread.id);
  }
  private serial<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(threadId) ?? Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(threadId, result);
    return result.finally(() => { if (this.queues.get(threadId) === result) this.queues.delete(threadId); });
  }
  async replay(threadId?: string): Promise<void> {
    if (threadId !== undefined) return this.serial(threadId, () => this.forwardPending(threadId));
    const threads = new Set(this.store.inbound().filter(message => message.state === 'pending' &&
      !this.queues.has(message.threadId)).map(message => message.threadId));
    const results = await Promise.allSettled([...threads].map(id => this.replay(id)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  private async stop(threadId: string, messageKey?: string, cutoff = messageKey): Promise<void> {
    if (this.leads) {
      await this.leads.stop(threadId, messageKey);
      if (cutoff) this.store.archivePendingPrompts(threadId, cutoff);
      if (messageKey) this.store.markInboundForwarded(messageKey);
      return;
    }
    const lead = this.store.leadSessions(threadId).find(session => session.active);
    if (lead) {
      await this.orca.call('worker-stop', ['--dispatch', lead.dispatchId]);
      this.store.endLead(lead.id);
    }
    if (cutoff) this.store.archivePendingPrompts(threadId, cutoff);
    if (messageKey) this.store.markInboundForwarded(messageKey);
  }
  replayStops(threadId: string): Promise<void> {
    return this.serial(threadId, () => this.forwardStops(threadId));
  }
  private async forwardStops(threadId: string): Promise<void> {
    for (const message of this.store.inbound(threadId)) {
      if (message.state === 'pending' && message.kind === 'stop') await this.stop(threadId, message.key);
    }
  }
  private async forwardPending(threadId: string): Promise<void> {
    await this.forwardStops(threadId);
    if (this.leads) return this.leads.forward(threadId);
    for (const message of this.store.inbound(threadId)) {
      if (message.state !== 'pending') continue;
      const lead = this.store.leadSessions(message.threadId).find(session => session.active);
      if (!lead) continue;
      await this.orca.call('send', ['--to', `dispatch:${lead.dispatchId}`, '--run', lead.runId,
        '--type', 'status', '--subject', 'Slack follow-up', '--body', this.text(message.text)]);
      this.store.markInboundForwarded(message.key);
    }
  }
  action(action: Action): Promise<boolean> {
    const cutoff = action.actionId === 'stop' ? this.store.inbound(action.threadId).at(-1)?.key : undefined;
    return this.serial(action.threadId, async () => {
      const thread = this.store.thread(action.threadId);
      if (!thread || thread.channel !== action.channel) return false;
      if (!this.allowedUsers.includes(action.user) || (action.actionId !== 'stop' && action.user !== thread.owner)) {
        await this.slack.refuse(action.channel, action.user);
        return false;
      }
      const lead = this.store.leadSessions(thread.id).find(session => session.active);
      if (action.actionId === 'stop') {
        await this.stop(thread.id, undefined, cutoff);
      } else if (action.actionId === 'decision') {
        if (this.leads) return this.leads.answer(thread.id, action.decisionId, action.option, action.user);
        const decision = this.store.decision(action.decisionId);
        if (!lead || !decision || decision.threadId !== thread.id || decision.answer !== undefined ||
            !decision.options.includes(action.option)) return false;
        await this.orca.call('reply', ['--id', decision.id, '--body', action.option, '--run', lead.runId]);
        this.store.answerDecision(decision.id, action.option, action.user);
      } else {
        await this.slack.ownerAction(action);
      }
      return true;
    });
  }
  private text(text: string): string { return text.split(`<@${this.botId}>`).join('').trim(); }
}
