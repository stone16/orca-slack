import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createSocketMode, type AdapterOptions, type SlackAdapter } from './bolt.js';
import { Cleanup } from './cleanup.js';
import { redactingLog, type Config, type Log } from './config.js';
import type { RunCommand } from './commands.js';
import { LeadCli } from './lead-orca.js';
import { Leads } from './leads.js';
import { PrPoller } from './pr-poller.js';
import { installPushGuard } from './push-guard.js';
import { ReportLoop, type ReportStep } from './report-loop.js';
import type { StatusView, WorkState } from './render.js';
import { Store, type Report } from './store.js';
import { UnboundThreads } from './unbound-threads.js';

interface SocketMode {
  adapter: SlackAdapter; app: { start(): Promise<unknown>; stop(): Promise<unknown> };
  socket: { on(event: string, listener: () => void): unknown; off(event: string, listener: () => void): unknown };
}
export interface RuntimeOptions {
  run?: RunCommand; log?: Log;
  socketMode?: (store: Store, options: AdapterOptions, log: (level: string, message: string) => void) => SocketMode;
  installGuard?: typeof installPushGuard; checkpoint?: (step: ReportStep) => void | Promise<void>;
}
const execute = promisify(execFile);
function command(coordinatorTerminal: string): RunCommand {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_') && !key.startsWith('SLACK_')));
  env.ORCA_TERMINAL_HANDLE = coordinatorTerminal;
  return async (program, args) => (await execute(program, args, {
    env, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  })).stdout;
}

export class Runtime {
  private store: Store;
  private orca: LeadCli;
  private leads: Leads;
  private cleanup: Cleanup;
  private poller: PrPoller;
  private unbound: UnboundThreads;
  private reports: ReportLoop;
  private socket?: SocketMode;
  private pending = new Set<Promise<unknown>>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private closed = false;
  private connectedOnce = false;
  private log: Log;
  private prQueue: Promise<void> = Promise.resolve();
  constructor(private config: Config, private options: RuntimeOptions = {}) {
    this.log = options.log ?? redactingLog(process.env);
    const boundary = options.run ?? command(config.coordinatorTerminal);
    const run: RunCommand = (program, args) => {
      const normalized = [...args];
      if (program === 'gh') {
        const index = normalized.indexOf('--repo') + 1;
        const repository = config.repositories.find(repository => repository.id === normalized[index]);
        if (index > 0 && repository) normalized[index] = repository.github;
      }
      return boundary(program, normalized);
    };
    mkdirSync(join(config.checkout, 'data'), { recursive: true, mode: 0o700 });
    this.store = new Store(join(config.checkout, 'data', 'bridge.sqlite'));
    this.orca = new LeadCli(async args => {
      try { return { stdout: await run('orca', args) }; }
      catch (error) { return { stdout: (error as { stdout?: string }).stdout ?? '', failed: true }; }
    });
    this.leads = new Leads(this.orca, this.store, config);
    this.cleanup = new Cleanup(this.store, run);
    this.poller = new PrPoller(this.store, run);
    try {
      this.unbound = new UnboundThreads(config);
    } catch {
      this.store.close();
      throw new Error('Invalid configuration field archiveDirectory');
    }
    this.reports = new ReportLoop(this.orca, this.store, config.runId, report => this.deliver(report), options.checkpoint);
  }
  private work = (job: () => Promise<void>): Promise<void> => {
    if (this.stopping || this.closed) return Promise.resolve();
    const result = Promise.resolve().then(job);
    this.pending.add(result);
    void result.finally(() => this.pending.delete(result)).catch(() => {});
    return result;
  };
  start(): Promise<void> {
    if (this.closed || this.stopping) return Promise.reject(new Error('Runtime has stopped'));
    return this.starting ??= this.work(() => this.startup());
  }
  private async startup(): Promise<void> {
    for (const [index, repository] of this.config.repositories.entries()) {
      try { (this.options.installGuard ?? installPushGuard)(repository.path, this.config.hooksDirectory); }
      catch { throw new Error(`Invalid configuration fields repositories[${index}].path or hooksDirectory; push guard installation failed`); }
      this.log('info', 'push guard installed');
    }
    this.socket = (this.options.socketMode ?? createSocketMode)(this.store, {
      orca: this.orca, allowedUsers: this.config.allowedUsers, botId: this.config.botId,
      leads: this.leads, unboundThreads: this.unbound, handle: this.work,
      statusView: id => this.status(id), ownerAction: action => this.ownerAction(action), logTail: id => this.logTail(id),
    }, this.log);
    this.socket.socket.on('connected', this.connected);
    this.socket.socket.on('disconnected', this.disconnected);
    this.socket.socket.on('reconnecting', this.reconnecting);
    const pendingReports = this.store.reports(this.config.runId).filter(report => report.state === 'pending').length;
    const coverage = await this.reports.recover();
    this.log(coverage.state === 'complete' ? 'info' : 'warn', `Orca inbox reconciled coverage=${coverage.state} count=${coverage.count}`);
    if (this.stopping) return;
    await this.socket.adapter.replay();
    this.log('info', `startup replay complete pendingReports=${pendingReports}`);
    if (this.stopping) return;
    await this.pollPullRequests();
    await this.leads.poll();
    await this.refresh();
    await this.retain();
    if (this.stopping) return;
    try { await this.socket.app.start(); }
    catch { throw new Error('Slack startup failed; check SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and botId'); }
    if (this.stopping) return;
    this.repeat(5_000, async () => { await this.reports.poll(); await this.leads.poll(); await this.socket!.adapter.replay(); await this.refresh(); });
    this.repeat(60_000, () => this.pollPullRequests());
    this.repeat(3_600_000, () => this.retain());
    this.log('info', 'bridge ready');
  }
  private connected = () => {
    this.log('info', 'Socket Mode connected');
    if (this.connectedOnce) void this.work(() => this.socket!.adapter.replay()).catch(error => this.log('error', error));
    this.connectedOnce = true;
  };
  private reconnecting = () => { this.log('warn', 'Socket Mode reconnecting'); };
  private disconnected = () => { this.log('warn', 'Socket Mode disconnected'); };
  private repeat(milliseconds: number, job: () => Promise<void>): void {
    let busy = false;
    this.timers.push(setInterval(() => {
      if (busy) return;
      busy = true;
      void this.work(job).catch(error => this.log('error', error)).finally(() => { busy = false; });
    }, milliseconds));
  }
  private pollPullRequests(threadId?: string): Promise<void> {
    const result = this.prQueue.catch(() => {}).then(async () => {
      const result = await this.poller.poll(threadId, async change => {
        const tree = this.store.trackedWorktrees().find(tree => tree.id === change.worktreeId);
        if (tree) await this.refresh(tree.threadId);
      });
      for (const failure of result.failures) this.log('warn', failure.reason);
    });
    this.prQueue = result;
    return result;
  }
  private async retain(): Promise<void> {
    const result = this.unbound.archiveExpired();
    this.log('info', `retention complete archived=${result.archived.length} retained=${result.retained.length}`);
    for (const item of result.retained) this.log('warn', `retention deferred: ${item.reason}`);
  }
  private async deliver(report: Report): Promise<void> {
    let payload: { dispatchId?: string; taskId?: string; outcome?: string };
    try { payload = JSON.parse(report.payload ?? '{}'); } catch { return; }
    if (!payload || typeof payload !== 'object') return;
    const thread = this.store.threads().find(thread => this.store.leadSessions(thread.id).some(session =>
      session.dispatchId === payload.dispatchId && session.taskId === payload.taskId && session.runId === report.runId));
    await this.leads.report(report);
    if (!thread) return;
    const adapter = this.socket!.adapter;
    if (report.type === 'question') {
      const decision = this.store.decision(report.id);
      let question = report.body ?? report.subject ?? '';
      try { const body = JSON.parse(question); if (typeof body?.question === 'string') question = body.question; } catch {}
      if (decision) await adapter.decision({ threadId: thread.id, id: report.id, owner: thread.owner, question, options: decision.options });
    } else if (report.type === 'worker_done' && (payload.outcome === 'succeeded' || payload.outcome === 'failed')) {
      if (!this.store.leadEvents(thread.id).some(event => event.key === report.id && ['completed', 'failed'].includes(event.kind))) return;
      await this.pollPullRequests(thread.id);
      await adapter.result({ threadId: thread.id, id: report.id, owner: thread.owner, outcome: payload.outcome,
        text: report.body ?? report.subject ?? '', needsAttention: payload.outcome === 'failed' });
    }
    await this.refresh(thread.id);
  }
  private status(threadId: string): StatusView | undefined {
    const thread = this.store.thread(threadId);
    if (!thread) return;
    const events = this.store.leadEvents(threadId), sessions = this.store.leadSessions(threadId);
    const trees = this.store.trackedWorktrees(threadId), prs = this.store.observedPullRequests(threadId);
    const latest = events.at(-1)?.kind;
    const states: Partial<Record<NonNullable<typeof latest>, WorkState>> = {
      failed: 'failed', stopped: 'stopped', interrupted: 'interrupted', unknown: 'unknown', waiting: 'waiting',
      started: 'implementing', running: 'implementing', answered: 'implementing', 'repository-required': 'discussing',
    };
    let state: WorkState = (latest && states[latest]) || (trees.length ? 'implementing' : 'classifying');
    if (!['failed', 'stopped', 'interrupted', 'unknown', 'waiting'].includes(state)) {
      if (prs.some(pr => pr.state === 'OPEN')) state = 'pr-open';
      if (!sessions.some(session => session.active) && trees.length > 0 && trees.every(tree => {
        const matching = prs.filter(pr => pr.worktreeId === tree.id);
        return matching.length > 0 && matching.every(pr => pr.state === 'MERGED');
      })) state = 'awaiting-verification';
      if (!trees.length && this.store.cleanupReceipts(threadId).some(receipt => receipt.state === 'deleted')) state = 'cleaned';
    }
    return { threadId, title: '任务', state, worktrees: trees.map(tree => {
      const pr = prs.filter(pr => pr.worktreeId === tree.id).sort((a, b) => a.number - b.number).at(-1);
      return { id: tree.id, repository: this.config.repositories.find(repository => repository.id === tree.repository)?.name ?? tree.repository,
        branch: tree.branch, state, hasCommits: true, agentActive: sessions.some(session => session.worktreeId === tree.id && session.active),
        ...(pr ? { pullRequest: { number: pr.number, url: pr.url, state: pr.state.toLowerCase() as 'open' | 'closed' | 'merged' } } : {}) };
    }) };
  }
  private async refresh(threadId?: string): Promise<void> {
    for (const thread of this.store.threads()) {
      if (threadId !== undefined && thread.id !== threadId) continue;
      await this.socket!.adapter.status(this.status(thread.id)!);
    }
  }
  private async ownerAction(action: Parameters<AdapterOptions['ownerAction']>[0]): Promise<void> {
    if (action.actionId === 'retry') {
      if (!action.operationKey) throw new Error('Retry requires an operation key');
      this.store.requestRetry(action.threadId, action.operationKey, action.user);
      if (!this.store.retryStarted(action.threadId, action.operationKey)) await this.leads.forward(action.threadId);
      if (!this.store.retryStarted(action.threadId, action.operationKey)) throw new Error('Retry launch is not confirmed; the saved request remains pending');
    } else if (action.actionId === 'cleanup') {
      const refused: string[] = [];
      for (const tree of this.store.trackedWorktrees(action.threadId)) {
        const result = await this.cleanup.confirm(tree.id, action.user);
        if (result.status === 'refused') refused.push(...result.reasons);
      }
      if (refused.length) throw new Error(`Cleanup refused: ${refused.join(', ')}`);
    } else throw new Error('Repository switching is not available in M1');
  }
  private async logTail(threadId: string): Promise<string> {
    const session = this.store.leadSessions(threadId).at(-1);
    if (!session) return '';
    const result = await this.orca.call<{ text?: string; output?: string }>('worker-read', ['--dispatch', session.dispatchId]);
    return result.text ?? result.output ?? '';
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    this.stopping = Promise.resolve().then(async () => {
      const disconnected = Promise.allSettled(this.socket ? [this.socket.app.stop()] : []);
      await Promise.allSettled([...this.pending]);
      const result = await disconnected;
      this.socket?.socket.off('connected', this.connected);
      this.socket?.socket.off('disconnected', this.disconnected);
      this.socket?.socket.off('reconnecting', this.reconnecting);
      this.store.close();
      this.closed = true;
      const failed = result.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    });
    return this.stopping;
  }
}
