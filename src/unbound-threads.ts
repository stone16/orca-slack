import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SlackEvent, Store, Thread } from './store.js';

export interface UnboundThread { thread: Thread; messages: SlackEvent[]; updatedAt: number }
export interface UnboundThreadOptions {
  checkout: string; archiveDirectory?: string; retentionDays?: number; isBound?: (id: string) => boolean;
}
export interface ArchiveResult { archived: string[]; retained: { id: string; reason: string }[] }

export class UnboundThreads {
  private directory: string;
  private retention: number;
  private store?: Store;
  constructor(private options: UnboundThreadOptions) {
    this.directory = resolve(options.checkout, 'data', 'threads');
    this.retention = (options.retentionDays ?? 30) * 86_400_000;
    if (!Number.isFinite(this.retention) || this.retention <= 0) throw new Error('Invalid retention');
    if (options.archiveDirectory !== undefined && !options.archiveDirectory.trim()) throw new Error('Invalid archive directory');
    this.options = { ...options, archiveDirectory: options.archiveDirectory ? resolve(options.archiveDirectory) : undefined };
    this.assertSeparate();
  }
  trackBindings(store: Store): void { this.store = store; }
  private isBound(id: string): boolean { return !!(this.store?.worktrees(id).length || this.options.isBound?.(id)); }
  private assertSeparate(): void {
    const canonical = (path: string, links = 0): string => {
      if (links > 40) throw new Error('Invalid storage symlink');
      try { return realpathSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try {
          if (lstatSync(path).isSymbolicLink()) return canonical(resolve(dirname(path), readlinkSync(path)), links + 1);
        } catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing; }
        return join(canonical(dirname(path), links), basename(path));
      }
    };
    if (this.options.archiveDirectory) {
      const archive = canonical(this.options.archiveDirectory), local = canonical(this.directory);
      const contains = (parent: string, child: string) => parent === child ||
        child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
      if (contains(archive, local) || contains(local, archive)) {
        throw new Error('Archive must be separate from local thread storage');
      }
    }
  }
  private locked<T>(work: () => T): T {
    this.assertSeparate();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = new DatabaseSync(join(dirname(this.directory), 'thread-lock.sqlite'));
    try {
      lock.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      const result = work();
      lock.exec('COMMIT');
      return result;
    } finally { lock.close(); }
  }
  private mounted(): boolean {
    if (!this.options.archiveDirectory) return false;
    try { return statSync(this.options.archiveDirectory).isDirectory() &&
      statSync(this.options.archiveDirectory).dev !== statSync(this.directory).dev; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private filename(id: string): string { return `${createHash('sha256').update(id).digest('hex')}.json`; }
  private parse(content: Buffer, filename: string): UnboundThread {
    let value;
    try { value = JSON.parse(content.toString()); } catch { throw new Error('Invalid thread record'); }
    const text = (value: unknown) => typeof value === 'string' && value.length > 0;
    if (!value || !value.thread || !['id', 'channel', 'threadTs', 'owner'].every(key => text(value.thread[key])) ||
      !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 || !Array.isArray(value.messages) ||
      value.messages.some((message: SlackEvent) => !message ||
        !['installationId', 'eventId', 'channel', 'ts', 'user'].every(key => text(message[key as keyof SlackEvent])) ||
        typeof message.text !== 'string' || message.channel !== value.thread.channel ||
        (message.threadTs ?? message.ts) !== value.thread.threadTs) || this.filename(value.thread.id) !== filename) {
      throw new Error('Invalid thread record');
    }
    return value as UnboundThread;
  }
  private content(directory: string, file: string): Buffer | undefined {
    try {
      if (!lstatSync(join(directory, file)).isFile()) throw new Error('Archive verification failed');
      return readFileSync(join(directory, file));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private merge(records: UnboundThread[]): UnboundThread | undefined {
    records.sort((a, b) => a.updatedAt - b.updatedAt);
    const newest = records.at(-1);
    if (!newest) return undefined;
    const messages: SlackEvent[] = [];
    for (const record of records) for (const message of record.messages) {
      const index = messages.findIndex(saved => saved.installationId === message.installationId &&
        (saved.eventId === message.eventId || (saved.channel === message.channel && saved.ts === message.ts)));
      if (index < 0) messages.push(message);
    }
    messages.sort((a, b) => {
      const [as, af = ''] = a.ts.split('.'), [bs, bf = ''] = b.ts.split('.');
      if (BigInt(as) !== BigInt(bs)) return BigInt(as) < BigInt(bs) ? -1 : 1;
      return af.padEnd(Math.max(af.length, bf.length), '0').localeCompare(bf.padEnd(Math.max(af.length, bf.length), '0'));
    });
    return { thread: newest.thread, messages, updatedAt: newest.updatedAt };
  }
  private load(id: string): { record?: UnboundThread; archive?: Buffer } {
    const file = this.filename(id);
    const local = this.content(this.directory, file);
    const archive = this.mounted() ? this.content(this.options.archiveDirectory!, file) : undefined;
    return { archive, record: this.merge([archive, local].filter((value): value is Buffer => value !== undefined)
      .map(content => this.parse(content, file))) };
  }
  read(id: string): UnboundThread | undefined {
    return this.locked(() => this.load(id).record);
  }
  append(thread: Thread, event: SlackEvent, now = Date.now()): UnboundThread {
    return this.locked(() => {
      const saved = this.load(thread.id);
      const record = this.merge([...(saved.record ? [saved.record] : []), { thread, messages: [event], updatedAt: now }])!;
      this.parse(Buffer.from(JSON.stringify(record)), this.filename(thread.id));
      const local = this.write(record);
      this.removeArchive(thread.id, saved.archive, local);
      return record;
    });
  }
  reactivate(id: string, now = Date.now()): UnboundThread | undefined {
    return this.locked(() => {
      const saved = this.load(id), record = saved.record;
      if (!record) return undefined;
      record.updatedAt = now;
      this.parse(Buffer.from(JSON.stringify(record)), this.filename(id));
      const local = this.write(record);
      this.removeArchive(id, saved.archive, local);
      return record;
    });
  }
  private removeArchive(id: string, archived: Buffer | undefined, local: Buffer): void {
    if (!archived || !this.mounted()) return;
    const file = this.filename(id);
    if (!this.content(this.directory, file)?.equals(local) ||
        !this.content(this.options.archiveDirectory!, file)?.equals(archived)) return;
    rmSync(join(this.options.archiveDirectory!, file));
    this.sync(this.options.archiveDirectory!);
  }
  private sync(file: string): void {
    const fd = openSync(file, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  private write(record: UnboundThread): Buffer {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); }
      finally { closeSync(fd); }
      const destination = join(this.directory, this.filename(record.thread.id));
      const content = readFileSync(temporary);
      renameSync(temporary, destination);
      if (!readFileSync(destination).equals(content)) throw new Error('Local verification failed');
      this.sync(this.directory);
      return content;
    } finally { rmSync(temporary, { force: true }); }
  }
  archiveExpired(now = Date.now()): ArchiveResult {
    return this.locked(() => this.archive(now));
  }
  private archive(now: number): ArchiveResult {
    const result: ArchiveResult = { archived: [], retained: [] };
    const files = readdirSync(this.directory);
    for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
      let id = file;
      let temporary: string | undefined;
      try {
        const source = join(this.directory, file);
        const content = this.content(this.directory, file);
        if (!content) continue;
        const record = this.parse(content, file);
        id = record.thread.id;
        if (now - record.updatedAt < this.retention || this.isBound(id)) continue;
        if (!this.options.archiveDirectory) throw new Error('Archive is not configured');
        if (!this.mounted()) throw new Error('Archive is not mounted');
        const destination = join(this.options.archiveDirectory, file);
        const previous = this.content(this.options.archiveDirectory, file);
        let combined = record, damaged = false;
        if (previous) {
          try { combined = this.merge([this.parse(previous, file), record])!; }
          catch { damaged = true; }
        }
        if (now - combined.updatedAt < this.retention) continue;
        const archived = Buffer.from(JSON.stringify(combined));
        temporary = join(this.options.archiveDirectory, `.${randomUUID()}.tmp`);
        const fd = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(fd, archived); fsyncSync(fd); } finally { closeSync(fd); }
        if (!lstatSync(temporary).isFile() || !readFileSync(temporary).equals(archived)) throw new Error('Archive verification failed');
        if (!this.mounted()) throw new Error('Archive is not mounted');
        const current = this.content(this.options.archiveDirectory, file);
        if (previous ? !current?.equals(previous) : current !== undefined) throw new Error('Archive changed during archival');
        if (damaged) renameSync(destination, `${destination}.recovery-${randomUUID()}`);
        renameSync(temporary, destination);
        if (!this.content(this.options.archiveDirectory, file)?.equals(archived)) throw new Error('Archive verification failed');
        this.sync(this.options.archiveDirectory);
        if (!this.mounted() || !this.content(this.directory, file)?.equals(content) ||
            !this.content(this.options.archiveDirectory, file)?.equals(archived)) throw new Error('Thread changed during archival');
        if (this.isBound(id)) continue;
        rmSync(source);
        this.sync(this.directory);
        result.archived.push(id);
      } catch (error) {
        result.retained.push({ id, reason: (error as NodeJS.ErrnoException).code ?? (error as Error).message });
      } finally { if (temporary) rmSync(temporary, { force: true }); }
    }
    return result;
  }
}
