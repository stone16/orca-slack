import type { Config } from './config.js';
import type { Orca } from './orca.js';
import { Store } from './store.js';
import { options, payload, post, react, render, terminalTail, type Message, type Slack } from './render.js';

export interface Delivery { deliveryId?: string | null; messages: Message[] }
export class ReportLoop {
  constructor(private orca: Orca, private slack: Slack, private store: Store,
    private config: Config, private runId: string, private heartbeat: () => void,
    private log: (event: string, error?: unknown) => void,
    private beforeDelivery: () => Promise<void> = async () => {}) {}
  async processDelivery(delivery: Delivery): Promise<void> {
    for (const message of delivery.messages) {
      const p = payload(message);
      let thread = typeof p.dispatchId === 'string' ? this.store.byDispatch(p.dispatchId) : undefined;
      if (!thread) {
        await this.beforeDelivery();
        thread = typeof p.dispatchId === 'string' ? this.store.byDispatch(p.dispatchId) : undefined;
      }
      if (!thread) {
        await post(this.slack, this.config.opsChannel, undefined, { text: `未关联 dispatch ${String(p.dispatchId ?? '(missing)')} · ${message.id}\n${render(message).text}` });
        continue;
      }
      if (message.type === 'worker_done' && p.outcome !== 'succeeded' && p.outcome !== 'failed') {
        throw new Error(`Missing worker_done outcome: ${message.id}`);
      }
      let card = render(message);
      const answered = message.type === 'question' ? this.store.question(message.id) : undefined;
      if (answered?.answered_by) card = { text: `${answered.answered_by} answered this question.`, blocks: [] };
      const failed = message.type === 'escalation' || (message.type === 'worker_done' && p.outcome === 'failed');
      if (failed && !['done', 'stopped'].includes(thread.status)) {
        try {
          const receipt = await this.orca.call<{ terminal?: { tail?: string[] } }>('worker-read', ['--dispatch', thread.dispatch_id, '--source', 'terminal']);
          card.text += `\n终端末 40 行：\n${terminalTail(receipt) || '(empty)'}`;
        } catch { card.text += '\n终端输出不可用；请用 worker-read 检查该 dispatch。'; }
      }
      const slackTs = await post(this.slack, thread.channel, thread.thread_ts, card);
      if (message.type === 'question') {
        this.store.saveQuestion(message.id, thread.thread_ts, options(message), slackTs);
      }
      if (['done', 'stopped'].includes(thread.status)) continue;
      if (failed) await react(this.slack, thread.channel, thread.thread_ts, 'x');
      // An escalation is not a settlement: the worker is still live and waits for a human (!stop or a reply), so only worker_done releases.
      if (message.type === 'worker_done') {
        if (!failed) await react(this.slack, thread.channel, thread.thread_ts, 'white_check_mark');
        try { await this.orca.call('worker-release', ['--dispatch', thread.dispatch_id]); }
        catch (error) { this.log('release_error', error); } // a failed release must not block the ack, or the delivery replays forever
        if (!['done', 'stopped'].includes(this.store.byThread(thread.thread_ts)!.status)) this.store.setStatus(thread.thread_ts, failed ? 'failed' : 'done');
      }
    }
  }
  async run(signal?: AbortSignal): Promise<void> {
    let delivery: Delivery | undefined;
    while (!signal?.aborted) {
      try {
        delivery ??= await this.orca.call<Delivery>('check', ['--wait', '--run', this.runId, '--types',
          'worker_done,question,escalation,merge_ready', '--timeout-ms', '600000']);
        await this.processDelivery(delivery);
        const id = delivery.deliveryId;
        delivery = undefined;
        if (id) {
          this.heartbeat();
          // shortcut: crash before ack can post twice, add a durable outbox when duplicates become unacceptable.
          delivery = await this.orca.call<Delivery>('check', ['--ack', id, '--run', this.runId]);
        }
      } catch (error) {
        delivery = undefined;
        this.log('report_error', error);
        if (!signal?.aborted) await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
}
