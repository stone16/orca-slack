import { DatabaseSync } from 'node:sqlite';
import type { Inbox, Message } from './orca.js';

export interface Thread {
  id: string; channel: string; threadTs: string; owner: string; linearTicket?: string;
}
export interface Worktree {
  id: string; threadId: string; repository: string; branch: string;
}
export interface PullRequest { id: string; worktreeId: string; url: string }
export interface LeadSession {
  id: string; threadId: string; worktreeId: string; runId: string;
  taskId: string; dispatchId: string; handle: string; active: boolean;
}
export interface Decision {
  id: string; threadId: string; options: string[]; slackTs: string;
  answer?: string; answeredBy?: string;
}
export interface Report extends Message { runId: string; state: 'pending' | 'sent' }
export interface Coverage { state: 'complete' | 'gap'; count: number }
export interface SlackEvent {
  installationId: string; eventId: string; channel: string; ts: string; threadTs?: string;
  user: string; text: string; botMessage?: boolean;
}
export interface Inbound extends SlackEvent {
  key: string; threadId: string; kind: 'prompt' | 'stop' | 'archive'; state: 'pending' | 'forwarded' | 'archived';
}
export interface ObservedPullRequest extends PullRequest {
  number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; headRefOid: string;
}
export interface CleanupReceipt {
  id: string; worktreeId: string; threadId: string; worktree: Worktree; instanceId: string; identity: string; path: string;
  finalCommit: string; pullRequests: ObservedPullRequest[]; sessions: LeadSession[]; reports: Report[];
  confirmedBy: string; savedAt: string; state: 'saved' | 'deleted'; removalReceipt?: unknown;
}
export interface PullRequestChange { id: number; pullRequest: ObservedPullRequest }
export interface SlackCard { threadId: string; key: string; ts: string; view: string }

export interface RoutingSample {
  threadId: string; text: string; repository: string | null;
  intent: 'question' | 'clarify' | 'implement'; rule: string;
}
export interface LeadEvent {
  threadId: string; key: string; kind: 'routed' | 'repository-required' | 'started' | 'waiting' | 'answered' |
    'completed' | 'failed' | 'stopped' | 'unknown' | 'interrupted' | 'running';
  text: string; sessionId?: string;
}
export interface LeadObservation {
  sessionId: string; source: string; cursor: string; terminalSource: string; terminalCursor: string; frozen: number;
}

export class Store {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, channel TEXT NOT NULL, threadTs TEXT NOT NULL,
        owner TEXT NOT NULL, linearTicket TEXT, UNIQUE(channel, threadTs));
      CREATE TABLE IF NOT EXISTS worktrees (
        id TEXT PRIMARY KEY, threadId TEXT NOT NULL REFERENCES threads(id),
        repository TEXT NOT NULL, branch TEXT NOT NULL, UNIQUE(id, threadId));
      CREATE TABLE IF NOT EXISTS pull_requests (
        id TEXT PRIMARY KEY, worktreeId TEXT NOT NULL REFERENCES worktrees(id), url TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lead_sessions (
        id TEXT PRIMARY KEY, threadId TEXT NOT NULL REFERENCES threads(id), worktreeId TEXT NOT NULL,
        runId TEXT NOT NULL, taskId TEXT NOT NULL, dispatchId TEXT NOT NULL UNIQUE,
        handle TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0, 1)),
        FOREIGN KEY(worktreeId, threadId) REFERENCES worktrees(id, threadId));
      CREATE UNIQUE INDEX IF NOT EXISTS active_lead ON lead_sessions(threadId) WHERE active=1;
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY, threadId TEXT NOT NULL REFERENCES threads(id),
        options TEXT NOT NULL, slackTs TEXT NOT NULL, answer TEXT, answeredBy TEXT);
      CREATE TABLE IF NOT EXISTS reports (
        runId TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER, message TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'sent')),
        PRIMARY KEY(runId, id), UNIQUE(runId, sequence));
      CREATE TABLE IF NOT EXISTS coverage (
        runId TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('complete', 'gap')), count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbound (
        key TEXT PRIMARY KEY, installationId TEXT NOT NULL, eventId TEXT NOT NULL,
        threadId TEXT NOT NULL REFERENCES threads(id), message TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('prompt', 'stop', 'archive')),
        state TEXT NOT NULL CHECK(state IN ('pending', 'forwarded', 'archived')),
        UNIQUE(installationId, eventId));
      CREATE TABLE IF NOT EXISTS pr_observations (
        id TEXT PRIMARY KEY REFERENCES pull_requests(id), number INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('OPEN', 'CLOSED', 'MERGED')), headRefOid TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cleanup_receipts (
        worktreeId TEXT PRIMARY KEY, threadId TEXT NOT NULL, record TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('saved', 'deleted')), removalReceipt TEXT,
        FOREIGN KEY(worktreeId, threadId) REFERENCES worktrees(id, threadId));
      CREATE UNIQUE INDEX IF NOT EXISTS pull_request_url ON pull_requests(url);
      CREATE TABLE IF NOT EXISTS pull_request_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, worktreeId TEXT NOT NULL REFERENCES worktrees(id), payload TEXT NOT NULL);`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routing_samples (
        threadId TEXT PRIMARY KEY REFERENCES threads(id), text TEXT NOT NULL, repository TEXT,
        intent TEXT NOT NULL, rule TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lead_events (
        threadId TEXT NOT NULL REFERENCES threads(id), key TEXT NOT NULL, kind TEXT NOT NULL,
        text TEXT NOT NULL, sessionId TEXT, PRIMARY KEY(threadId, key));
      CREATE TABLE IF NOT EXISTS lead_observations (
        sessionId TEXT PRIMARY KEY REFERENCES lead_sessions(id), source TEXT NOT NULL, cursor TEXT NOT NULL,
        terminalSource TEXT NOT NULL, terminalCursor TEXT NOT NULL, frozen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lead_launches (
        threadId TEXT PRIMARY KEY REFERENCES threads(id), id TEXT NOT NULL, dispatchId TEXT);
      CREATE TABLE IF NOT EXISTS stopped_lead_dispatches (
        dispatchId TEXT PRIMARY KEY, threadId TEXT NOT NULL REFERENCES threads(id));`);
    if (!this.db.prepare('PRAGMA table_info(lead_launches)').all().some(column => column.name === 'promptKey')) {
      this.db.exec('ALTER TABLE lead_launches ADD COLUMN promptKey TEXT REFERENCES inbound(key)');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS slack_cards (
        threadId TEXT NOT NULL REFERENCES threads(id), key TEXT NOT NULL, ts TEXT NOT NULL, view TEXT NOT NULL,
        PRIMARY KEY(threadId, key));
      CREATE TABLE IF NOT EXISTS slack_reactions (
        inboundKey TEXT NOT NULL REFERENCES inbound(key), name TEXT NOT NULL,
        PRIMARY KEY(inboundKey, name));
      CREATE TABLE IF NOT EXISTS retry_requests (
        threadId TEXT NOT NULL REFERENCES threads(id), key TEXT NOT NULL, user TEXT NOT NULL,
        afterSessionId TEXT NOT NULL REFERENCES lead_sessions(id), promptKey TEXT NOT NULL REFERENCES inbound(key),
        PRIMARY KEY(threadId, key));
      CREATE TABLE IF NOT EXISTS slack_actions (
        threadId TEXT NOT NULL REFERENCES threads(id), key TEXT NOT NULL, user TEXT NOT NULL,
        PRIMARY KEY(threadId, key));`);
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveThread(thread: Thread): void {
    this.db.prepare(`INSERT INTO threads VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, linearTicket=excluded.linearTicket`)
      .run(thread.id, thread.channel, thread.threadTs, thread.owner, thread.linearTicket ?? null);
  }
  thread(id: string): Thread | undefined {
    const row = this.db.prepare('SELECT * FROM threads WHERE id=?').get(id);
    if (!row) return undefined;
    const { linearTicket, ...thread } = row;
    return { ...thread, ...(linearTicket === null ? {} : { linearTicket }) } as Thread;
  }
  threads(): Thread[] {
    return this.db.prepare('SELECT id FROM threads ORDER BY rowid').all().map(row => this.thread(row.id as string)!);
  }
  setDecisionSlackTs(id: string, ts: string): void {
    this.db.prepare('UPDATE decisions SET slackTs=? WHERE id=?').run(ts, id);
  }
  requestRetry(threadId: string, key: string, user: string): void {
    this.transaction(() => {
      if (this.thread(threadId)?.owner !== user) throw new Error('Only the owner can retry');
      if (this.slackAction(threadId, key) || this.db.prepare('SELECT 1 FROM retry_requests WHERE threadId=? AND key=?').get(threadId, key)) return;
      const failed = this.leadEvents(threadId).at(-1);
      if (this.leadSessions(threadId).some(session => session.active) || failed?.kind !== 'failed' || !failed.sessionId) {
        throw new Error('Retry requires a failed, inactive lead');
      }
      const message = this.inbound(threadId).filter(message => message.kind === 'prompt' && message.state !== 'archived').at(-1);
      if (!message) throw new Error('Retry has no saved prompt');
      this.db.prepare('INSERT INTO retry_requests VALUES (?, ?, ?, ?, ?)').run(threadId, key, user, failed.sessionId, message.key);
      this.db.prepare("UPDATE inbound SET state='pending' WHERE key=?").run(message.key);
    });
  }
  retryStarted(threadId: string, key: string): boolean {
    const request = this.db.prepare('SELECT afterSessionId FROM retry_requests WHERE threadId=? AND key=?').get(threadId, key);
    if (!request) return false;
    const sessions = this.leadSessions(threadId);
    const previous = sessions.findIndex(session => session.id === request.afterSessionId);
    return previous >= 0 && previous < sessions.length - 1;
  }
  findThread(channel: string, threadTs: string): Thread | undefined {
    const row = this.db.prepare('SELECT id FROM threads WHERE channel=? AND threadTs=?').get(channel, threadTs);
    return row ? this.thread(row.id as string) : undefined;
  }
  saveWorktree(tree: Worktree): void {
    this.db.prepare('INSERT INTO worktrees VALUES (?, ?, ?, ?)')
      .run(tree.id, tree.threadId, tree.repository, tree.branch);
  }
  worktrees(threadId: string): Worktree[] {
    return this.db.prepare('SELECT * FROM worktrees WHERE threadId=? ORDER BY rowid').all(threadId) as unknown as Worktree[];
  }
  savePullRequest(pr: PullRequest): void {
    this.db.prepare('INSERT INTO pull_requests VALUES (?, ?, ?)').run(pr.id, pr.worktreeId, pr.url);
  }
  pullRequests(threadId: string): PullRequest[] {
    return this.db.prepare(`SELECT p.* FROM pull_requests p JOIN worktrees w ON w.id=p.worktreeId
      WHERE w.threadId=? ORDER BY p.rowid`).all(threadId) as unknown as PullRequest[];
  }
  replaceLead(session: Omit<LeadSession, 'active'>): void {
    this.transaction(() => {
      this.db.prepare('UPDATE lead_sessions SET active=0 WHERE threadId=?').run(session.threadId);
      this.db.prepare('INSERT INTO lead_sessions VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
        .run(session.id, session.threadId, session.worktreeId, session.runId,
          session.taskId, session.dispatchId, session.handle);
    });
  }
  leadSessions(threadId: string): LeadSession[] {
    return this.db.prepare('SELECT * FROM lead_sessions WHERE threadId=? ORDER BY rowid').all(threadId)
      .map(row => ({ ...row, active: row.active === 1 })) as unknown as LeadSession[];
  }
  endLead(id: string): void {
    this.db.prepare('UPDATE lead_sessions SET active=0 WHERE id=?').run(id);
  }
  saveDecision(decision: Omit<Decision, 'answer' | 'answeredBy'>): void {
    this.db.prepare('INSERT INTO decisions VALUES (?, ?, ?, ?, NULL, NULL)')
      .run(decision.id, decision.threadId, JSON.stringify(decision.options), decision.slackTs);
  }
  decision(id: string): Decision | undefined {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id=?').get(id);
    if (!row) return undefined;
    const { options, answer, answeredBy, ...rest } = row;
    return { ...rest, options: JSON.parse(options as string),
      ...(answer === null ? {} : { answer, answeredBy }) } as Decision;
  }
  answerDecision(id: string, answer: string, user: string): boolean {
    const decision = this.decision(id);
    if (!decision?.options.includes(answer)) return false;
    return this.db.prepare('UPDATE decisions SET answer=?, answeredBy=? WHERE id=? AND answer IS NULL')
      .run(answer, user, id).changes === 1;
  }
  persistReports(runId: string, messages: Message[]): void {
    this.transaction(() => this.writeReports(runId, messages));
  }
  private writeReports(runId: string, messages: Message[]): void {
    for (const message of messages) {
      const existing = this.db.prepare('SELECT sequence FROM reports WHERE runId=? AND id=?').get(runId, message.id);
      if (existing?.sequence != null && message.sequence != null && existing.sequence !== message.sequence) {
        throw new Error(`Report sequence changed: ${message.id}`);
      }
      this.db.prepare(`INSERT INTO reports(runId, id, sequence, message) VALUES (?, ?, ?, ?)
        ON CONFLICT(runId, id) DO UPDATE SET sequence=COALESCE(reports.sequence, excluded.sequence)`)
        .run(runId, message.id, message.sequence ?? null, JSON.stringify(message));
    }
  }
  reports(runId: string): Report[] {
    return this.db.prepare('SELECT * FROM reports WHERE runId=? ORDER BY sequence, rowid').all(runId)
      .map(row => ({ ...JSON.parse(row.message as string), runId, state: row.state,
        ...(row.sequence === null ? {} : { sequence: row.sequence }) })) as Report[];
  }
  hasReport(runId: string, id: string, sequence: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM reports WHERE runId=? AND id=? AND sequence=?').get(runId, id, sequence);
  }
  markReportSent(runId: string, id: string): void {
    this.db.prepare("UPDATE reports SET state='sent' WHERE runId=? AND id=?").run(runId, id);
  }
  reconcileInbox(runId: string, inbox: Inbox, observedIds: readonly string[] = []): Coverage {
    return this.transaction(() => {
      const oldest = inbox.messages.reduce<Inbox['messages'][number] | undefined>(
        (a, b) => !a || b.sequence < a.sequence ? b : a, undefined);
      const complete = inbox.count < 1000 || (oldest && (this.hasReport(runId, oldest.id, oldest.sequence) ||
        (this.coverage(runId)?.state === 'complete' && observedIds.includes(oldest.id))));
      const coverage: Coverage = { state: complete && this.coverage(runId)?.state !== 'gap' ? 'complete' : 'gap',
        count: inbox.count };
      this.writeReports(runId, inbox.messages);
      this.db.prepare(`INSERT INTO coverage VALUES (?, ?, ?) ON CONFLICT(runId)
        DO UPDATE SET state=excluded.state, count=excluded.count`).run(runId, coverage.state, coverage.count);
      return coverage;
    });
  }
  coverage(runId: string): Coverage | undefined {
    return this.db.prepare('SELECT state, count FROM coverage WHERE runId=?').get(runId) as Coverage | undefined;
  }
  saveInbound(thread: Thread, event: SlackEvent, kind: Inbound['kind']): boolean {
    return this.transaction(() => {
      const key = JSON.stringify([event.installationId, event.channel, event.ts]);
      if (this.db.prepare('SELECT 1 FROM inbound WHERE key=? OR (installationId=? AND eventId=?)')
        .get(key, event.installationId, event.eventId)) return false;
      if (!this.thread(thread.id)) this.saveThread(thread);
      this.db.prepare('INSERT INTO inbound VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(key, event.installationId, event.eventId, thread.id, JSON.stringify(event), kind,
          kind === 'archive' ? 'archived' : 'pending');
      return true;
    });
  }
  inbound(threadId?: string): Inbound[] {
    const rows = threadId === undefined ? this.db.prepare('SELECT * FROM inbound ORDER BY rowid').all()
      : this.db.prepare('SELECT * FROM inbound WHERE threadId=? ORDER BY rowid').all(threadId);
    return rows.map(row => ({ ...JSON.parse(row.message as string), key: row.key, threadId: row.threadId,
      kind: row.kind, state: row.state })) as Inbound[];
  }
  markInboundForwarded(key: string): void {
    this.db.prepare("UPDATE inbound SET state='forwarded' WHERE key=? AND state='pending'").run(key);
  }
  archivePendingPrompts(threadId: string, throughKey?: string): void {
    this.db.prepare(`UPDATE inbound SET state='archived' WHERE threadId=? AND kind='prompt' AND state='pending'
      AND (? IS NULL OR rowid <= (SELECT rowid FROM inbound WHERE key=? AND threadId=?))`)
      .run(threadId, throughKey ?? null, throughKey ?? null, threadId);
  }
  saveRoutingSample(sample: RoutingSample): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO routing_samples VALUES (?, ?, ?, ?, ?)')
      .run(sample.threadId, sample.text, sample.repository, sample.intent, sample.rule).changes === 1;
  }
  routingSamples(threadId: string): RoutingSample[] {
    return this.db.prepare('SELECT * FROM routing_samples WHERE threadId=?').all(threadId) as unknown as RoutingSample[];
  }
  activeLeads(): LeadSession[] {
    return this.db.prepare('SELECT * FROM lead_sessions WHERE active=1 ORDER BY rowid').all()
      .map(row => ({ ...row, active: true })) as unknown as LeadSession[];
  }
  recordLeadEvent(event: LeadEvent, endSessionId?: string, decision?: Omit<Decision, 'answer' | 'answeredBy'>): void {
    this.transaction(() => {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO lead_events VALUES (?, ?, ?, ?, ?)')
        .run(event.threadId, event.key, event.kind, event.text, event.sessionId ?? null).changes;
      if (!inserted) return;
      if (decision) this.saveDecision(decision);
      if (endSessionId) this.endLead(endSessionId);
    });
  }
  leadEvents(threadId: string): LeadEvent[] {
    return this.db.prepare('SELECT * FROM lead_events WHERE threadId=? ORDER BY rowid').all(threadId)
      .map(({ sessionId, ...row }) => ({ ...row, ...(sessionId === null ? {} : { sessionId }) })) as unknown as LeadEvent[];
  }
  leadObservation(sessionId: string): LeadObservation | undefined {
    return this.db.prepare('SELECT * FROM lead_observations WHERE sessionId=?').get(sessionId) as unknown as LeadObservation | undefined;
  }
  saveLeadObservation(observation: LeadObservation): void {
    this.db.prepare(`INSERT INTO lead_observations VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sessionId)
      DO UPDATE SET source=excluded.source, cursor=excluded.cursor, terminalSource=excluded.terminalSource,
      terminalCursor=excluded.terminalCursor, frozen=excluded.frozen`)
      .run(observation.sessionId, observation.source, observation.cursor, observation.terminalSource,
        observation.terminalCursor, observation.frozen);
  }
  pendingLaunch(threadId: string): string | undefined {
    return this.db.prepare('SELECT id FROM lead_launches WHERE threadId=?').get(threadId)?.id as string | undefined;
  }
  pendingLeadLaunches(): { threadId: string; id: string; dispatchId?: string }[] {
    return this.db.prepare('SELECT * FROM lead_launches ORDER BY rowid').all()
      .map(({ dispatchId, ...row }) => ({ ...row, ...(dispatchId === null ? {} : { dispatchId }) })) as
      { threadId: string; id: string; dispatchId?: string }[];
  }
  beginLeadLaunch(threadId: string, id: string): void {
    this.db.prepare('INSERT INTO lead_launches(threadId, id) VALUES (?, ?)').run(threadId, id);
  }
  saveLaunchPrompt(threadId: string, promptKey: string): void {
    this.db.prepare('UPDATE lead_launches SET promptKey=? WHERE threadId=?').run(promptKey, threadId);
  }
  launchPromptKeys(threadId: string): string[] {
    return this.db.prepare(`SELECT key FROM inbound WHERE threadId=? AND kind='prompt' AND state='pending'
      AND rowid <= (SELECT i.rowid FROM inbound i JOIN lead_launches l ON l.promptKey=i.key
        WHERE l.threadId=? AND i.threadId=l.threadId) ORDER BY rowid`).all(threadId, threadId).map(row => row.key as string);
  }
  saveLaunchDispatch(threadId: string, dispatchId: string): void {
    this.db.prepare('UPDATE lead_launches SET dispatchId=? WHERE threadId=?').run(dispatchId, threadId);
  }
  launchDispatch(threadId: string): string | undefined {
    return this.db.prepare('SELECT dispatchId FROM lead_launches WHERE threadId=?').get(threadId)?.dispatchId as string | undefined;
  }
  ownsLeadDispatch(dispatchId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM lead_sessions WHERE dispatchId=?
      UNION ALL SELECT 1 FROM stopped_lead_dispatches WHERE dispatchId=? LIMIT 1`).get(dispatchId, dispatchId);
  }
  finishLeadLaunch(threadId: string, stoppedDispatchId?: string): void {
    if (stoppedDispatchId) {
      this.transaction(() => {
        this.db.prepare('INSERT OR IGNORE INTO stopped_lead_dispatches VALUES (?, ?)').run(stoppedDispatchId, threadId);
        this.db.prepare('DELETE FROM lead_launches WHERE threadId=?').run(threadId);
      });
    } else this.db.prepare('DELETE FROM lead_launches WHERE threadId=?').run(threadId);
  }
  pendingLeadDecisions(threadId: string): Decision[] {
    return this.db.prepare(`SELECT d.id FROM decisions d JOIN lead_events e ON d.id=e.key AND d.threadId=e.threadId
      JOIN lead_sessions s ON s.id=e.sessionId AND s.active=1
      WHERE d.threadId=? AND d.answer IS NULL AND e.kind='waiting' ORDER BY e.rowid`).all(threadId)
      .map(row => this.decision(row.id as string)!);
  }
  archiveInbound(key: string): void {
    this.db.prepare("UPDATE inbound SET state='archived' WHERE key=? AND state='pending'").run(key);
  }
  completeLeadLaunch(session: Omit<LeadSession, 'active'>, messageKeys: readonly string[]): void {
    this.transaction(() => {
      this.db.prepare('UPDATE lead_sessions SET active=0 WHERE threadId=?').run(session.threadId);
      this.db.prepare('INSERT INTO lead_sessions VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
        .run(session.id, session.threadId, session.worktreeId, session.runId,
          session.taskId, session.dispatchId, session.handle);
      this.finishLeadLaunch(session.threadId);
      this.db.prepare('INSERT INTO lead_events VALUES (?, ?, ?, ?, ?)')
        .run(session.threadId, `started:${session.id}`, 'started', 'Lead session started', session.id);
      for (const key of messageKeys) this.markInboundForwarded(key);
      for (const report of this.reports(session.runId)) {
        let payload;
        try { payload = JSON.parse(report.payload ?? '{}'); } catch { continue; }
        if (payload?.dispatchId === session.dispatchId && payload?.taskId === session.taskId) {
          this.db.prepare("UPDATE reports SET state='pending' WHERE runId=? AND id=?").run(report.runId, report.id);
        }
      }
    });
  }
  completeLeadReply(session: LeadSession, decisionId: string, answer: string, user: string, messageKey?: string): boolean {
    return this.transaction(() => {
      const changed = this.db.prepare('UPDATE decisions SET answer=?, answeredBy=? WHERE id=? AND answer IS NULL')
        .run(answer, user, decisionId).changes;
      if (!changed) return false;
      this.db.prepare('INSERT INTO lead_events VALUES (?, ?, ?, ?, ?)')
        .run(session.threadId, `answer:${decisionId}`, 'answered', answer, session.id);
      if (messageKey) this.markInboundForwarded(messageKey);
      return true;
    });
  }
  trackedWorktrees(threadId?: string): Worktree[] {
    return this.db.prepare(`SELECT w.* FROM worktrees w WHERE (? IS NULL OR w.threadId=?)
      AND NOT EXISTS (SELECT 1 FROM cleanup_receipts c WHERE c.worktreeId=w.id AND c.state='deleted')
      ORDER BY w.rowid`).all(threadId ?? null, threadId ?? null) as unknown as Worktree[];
  }
  observedPullRequests(threadId: string): ObservedPullRequest[] {
    return this.db.prepare(`SELECT p.*, o.number, o.state, o.headRefOid FROM pull_requests p
      JOIN pr_observations o ON o.id=p.id JOIN worktrees w ON w.id=p.worktreeId
      WHERE w.threadId=? ORDER BY p.rowid`).all(threadId) as unknown as ObservedPullRequest[];
  }
  observePullRequests(prs: ObservedPullRequest[]): ObservedPullRequest[] {
    return this.transaction(() => this.writePullRequests(prs));
  }
  saveCleanupReceipt(receipt: Omit<CleanupReceipt, 'state' | 'removalReceipt'>): CleanupReceipt {
    return this.transaction(() => {
      const previous = this.cleanupReceipt(receipt.worktreeId);
      if (previous) return previous;
      this.writePullRequests(receipt.pullRequests);
      this.db.prepare(`INSERT INTO cleanup_receipts VALUES (?, ?, ?, 'saved', NULL)`)
        .run(receipt.worktreeId, receipt.threadId, JSON.stringify(receipt));
      return this.cleanupReceipt(receipt.worktreeId)!;
    });
  }
  cleanupReceipt(worktreeId: string): CleanupReceipt | undefined {
    const row = this.db.prepare('SELECT * FROM cleanup_receipts WHERE worktreeId=?').get(worktreeId);
    if (!row) return undefined;
    return { ...JSON.parse(row.record as string), state: row.state,
      ...(row.removalReceipt === null ? {} : { removalReceipt: JSON.parse(row.removalReceipt as string) }) };
  }
  cleanupReceipts(threadId: string): CleanupReceipt[] {
    return this.db.prepare('SELECT worktreeId FROM cleanup_receipts WHERE threadId=? ORDER BY rowid').all(threadId)
      .map(row => this.cleanupReceipt(row.worktreeId as string)!);
  }
  markCleanupDeleted(worktreeId: string, receipt: unknown): void {
    this.db.prepare("UPDATE cleanup_receipts SET state='deleted', removalReceipt=? WHERE worktreeId=? AND state='saved'")
      .run(JSON.stringify(receipt), worktreeId);
  }
  private writePullRequests(prs: ObservedPullRequest[]): ObservedPullRequest[] {
    const changes: ObservedPullRequest[] = [];
    for (const observed of prs) {
      const existing = this.db.prepare(`SELECT p.*, o.number, o.state, o.headRefOid FROM pull_requests p
        LEFT JOIN pr_observations o ON o.id=p.id WHERE p.id=? OR p.url=? LIMIT 1`)
        .get(observed.id, observed.url);
      const pr = { ...observed, id: existing ? existing.id as string : observed.id };
      if (existing && existing.worktreeId !== pr.worktreeId) throw new Error('Pull request belongs to another worktree');
      if (existing && existing.url === pr.url && existing.number === pr.number &&
          existing.state === pr.state && existing.headRefOid === pr.headRefOid) continue;
      this.db.prepare(`INSERT INTO pull_requests VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET url=excluded.url`).run(pr.id, pr.worktreeId, pr.url);
      this.db.prepare(`INSERT INTO pr_observations VALUES (?, ?, ?, ?) ON CONFLICT(id)
        DO UPDATE SET number=excluded.number, state=excluded.state, headRefOid=excluded.headRefOid`)
        .run(pr.id, pr.number, pr.state, pr.headRefOid);
      this.db.prepare('INSERT INTO pull_request_changes(worktreeId, payload) VALUES (?, ?)')
        .run(pr.worktreeId, JSON.stringify(pr));
      changes.push(pr);
    }
    return changes;
  }
  pendingPullRequestChanges(threadId?: string): PullRequestChange[] {
    return this.db.prepare(`SELECT c.id, c.payload FROM pull_request_changes c JOIN worktrees w ON w.id=c.worktreeId
      WHERE (? IS NULL OR w.threadId=?) ORDER BY c.id`).all(threadId ?? null, threadId ?? null)
      .map(row => ({ id: row.id as number, pullRequest: JSON.parse(row.payload as string) }));
  }
  markPullRequestChangeDelivered(id: number): void {
    this.db.prepare('DELETE FROM pull_request_changes WHERE id=?').run(id);
  }
  saveSlackCard(card: SlackCard): void {
    this.db.prepare(`INSERT INTO slack_cards VALUES (?, ?, ?, ?) ON CONFLICT(threadId, key)
      DO UPDATE SET ts=excluded.ts, view=excluded.view`).run(card.threadId, card.key, card.ts, card.view);
  }
  slackCard(threadId: string, key: string): SlackCard | undefined {
    return this.db.prepare('SELECT * FROM slack_cards WHERE threadId=? AND key=?').get(threadId, key) as SlackCard | undefined;
  }
  hasSlackReaction(inboundKey: string, name: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM slack_reactions WHERE inboundKey=? AND name=?').get(inboundKey, name);
  }
  saveSlackReaction(inboundKey: string, name: string): void {
    this.db.prepare('INSERT OR IGNORE INTO slack_reactions VALUES (?, ?)').run(inboundKey, name);
  }
  slackAction(threadId: string, key: string): string | undefined {
    return this.db.prepare('SELECT user FROM slack_actions WHERE threadId=? AND key=?').get(threadId, key)?.user as string | undefined;
  }
  saveSlackAction(threadId: string, key: string, user: string): void {
    this.db.prepare('INSERT OR IGNORE INTO slack_actions VALUES (?, ?, ?)').run(threadId, key, user);
  }
  close(): void { this.db.close(); }
}
