import { CliOrca } from './orca.js';
import { Store, type Coverage, type Report } from './store.js';

export type ReportStep = 'before-peek' | 'after-peek' | 'after-peek-persist' | 'after-consume' |
  'after-consume-persist' | 'after-inbox' | 'after-send' | 'after-sent';

export class ReportLoop {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private orca: CliOrca, private store: Store, private runId: string,
    private send: (report: Report) => Promise<void>,
    private checkpoint: (step: ReportStep) => void | Promise<void> = () => {}) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => {}).then(work);
    this.queue = result;
    return result;
  }
  reconcile(): Promise<Coverage> { return this.serial(() => this.readInbox()); }
  private async readInbox(): Promise<Coverage> {
    const inbox = await this.orca.inbox(this.runId);
    const coverage = this.store.reconcileInbox(this.runId, inbox);
    await this.checkpoint('after-inbox');
    return coverage;
  }
  recover(): Promise<Coverage> { return this.serial(() => this.recoverPending()); }
  private async recoverPending(): Promise<Coverage> {
    const coverage = await this.readInbox();
    await this.flush();
    return coverage;
  }
  poll(): Promise<Coverage> { return this.serial(() => this.consumePending()); }
  private async consumePending(): Promise<Coverage> {
    await this.checkpoint('before-peek');
    const peek = await this.orca.peek(this.runId);
    await this.checkpoint('after-peek');
    this.store.persistReports(this.runId, peek);
    await this.checkpoint('after-peek-persist');
    const consumed = await this.orca.consume(this.runId);
    await this.checkpoint('after-consume');
    this.store.persistReports(this.runId, consumed);
    await this.checkpoint('after-consume-persist');
    return this.recoverPending();
  }
  private async flush(): Promise<void> {
    for (const report of this.store.reports(this.runId)) {
      if (report.state === 'sent') continue;
      await this.send(report);
      await this.checkpoint('after-send');
      this.store.markReportSent(this.runId, report.id);
      await this.checkpoint('after-sent');
    }
  }
}
