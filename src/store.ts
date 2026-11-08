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
        UNIQUE(installationId, eventId));`);
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
  reconcileInbox(runId: string, inbox: Inbox): Coverage {
    return this.transaction(() => {
      const oldest = inbox.messages.reduce<Inbox['messages'][number] | undefined>(
        (a, b) => !a || b.sequence < a.sequence ? b : a, undefined);
      const complete = inbox.count < 1000 || (oldest && this.hasReport(runId, oldest.id, oldest.sequence));
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
  close(): void { this.db.close(); }
}
