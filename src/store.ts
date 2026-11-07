import { DatabaseSync } from 'node:sqlite';

export interface Thread {
  thread_ts: string; channel: string; ts?: string; run_id: string; task_id: string; dispatch_id: string;
  worktree: string; repo: string; requester: string; status: string; created_at?: string; updated_at?: string;
}
export interface Question {
  message_id: string; thread_ts: string; options_json: string; slack_ts: string;
  answered_by: string | null; answered_at: string | null;
}
export class Store {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS threads (
        thread_ts TEXT PRIMARY KEY, channel TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
        dispatch_id TEXT NOT NULL, worktree TEXT NOT NULL, repo TEXT NOT NULL, requester TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ts TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS thread_message ON threads(channel, ts);
      CREATE UNIQUE INDEX IF NOT EXISTS thread_dispatch ON threads(dispatch_id) WHERE dispatch_id != '';
      CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, seen_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS questions (
        message_id TEXT PRIMARY KEY, thread_ts TEXT NOT NULL, options_json TEXT NOT NULL,
        answered_by TEXT, answered_at TEXT, slack_ts TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  claim(id: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?)').run(id, new Date().toISOString()).changes === 1;
  }
  saveThread(t: Thread): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_ts) DO UPDATE SET task_id=excluded.task_id, dispatch_id=excluded.dispatch_id,
      worktree=excluded.worktree, status=excluded.status, updated_at=excluded.updated_at`)
      .run(t.thread_ts, t.channel, t.run_id, t.task_id, t.dispatch_id, t.worktree, t.repo, t.requester, t.status, now, now, t.ts ?? t.thread_ts);
  }
  byThread(ts: string): Thread | undefined { return this.db.prepare('SELECT * FROM threads WHERE thread_ts=?').get(ts) as Thread | undefined; }
  byDispatch(id: string): Thread | undefined { return this.db.prepare('SELECT * FROM threads WHERE dispatch_id=?').get(id) as Thread | undefined; }
  setStatus(ts: string, status: string): void {
    this.db.prepare('UPDATE threads SET status=?, updated_at=? WHERE thread_ts=?').run(status, new Date().toISOString(), ts);
  }
  saveQuestion(id: string, ts: string, options: string[], slackTs: string): void {
    this.db.prepare(`INSERT INTO questions VALUES (?, ?, ?, NULL, NULL, ?)
      ON CONFLICT(message_id) DO UPDATE SET slack_ts=excluded.slack_ts`).run(id, ts, JSON.stringify(options), slackTs);
  }
  question(id: string): Question | undefined { return this.db.prepare('SELECT * FROM questions WHERE message_id=?').get(id) as Question | undefined; }
  pendingQuestion(ts: string): Question | undefined {
    return this.db.prepare('SELECT * FROM questions WHERE thread_ts=? AND answered_at IS NULL ORDER BY rowid LIMIT 1').get(ts) as Question | undefined;
  }
  answerQuestion(id: string, user: string): void {
    this.db.prepare('UPDATE questions SET answered_by=?, answered_at=? WHERE message_id=? AND answered_at IS NULL').run(user, new Date().toISOString(), id);
  }
  getMeta(key: string): string | undefined { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value; }
  setMeta(key: string, value: string): void { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(key, value); }
  close(): void { this.db.close(); }
}
