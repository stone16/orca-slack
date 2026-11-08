import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SlackEvent, Store, Thread } from './store.js';

export interface UnboundThread { thread: Thread; messages: SlackEvent[]; updatedAt: number }
export interface UnboundThreadOptions {
  checkout: string; archiveDirectory?: string; retentionDays?: number; isBound?: (id: string) => boolean;
}
export interface ArchiveResult { archived: string[]; retained: { id: string; reason: string }[] }
type ArchiveSnapshot = { state: 'ready'; bytes?: Buffer; record?: UnboundThread } | { state: 'unavailable' | 'damaged' };
const unavailable = (error: unknown) => ['ENOENT', 'ENOTDIR', 'ESTALE', 'EIO', 'ETIMEDOUT', 'ENOTCONN',
  'EHOSTDOWN', 'EHOSTUNREACH', 'ENETDOWN', 'ENETUNREACH', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '');

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
  private assertSeparate(): boolean {
    let ready = true;
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
      let archive: string;
      try { archive = canonical(this.options.archiveDirectory); }
      catch (error) {
        if (!unavailable(error)) throw error;
        archive = resolve(this.options.archiveDirectory);
        ready = false;
      }
      const local = canonical(this.directory);
      const contains = (parent: string, child: string) => parent === child ||
        child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
      if (contains(archive, local) || contains(local, archive)) {
        throw new Error('Archive must be separate from local thread storage');
      }
    }
    return ready;
  }
  private locked<T>(file: string, work: () => T, mode: 'read' | 'write' = 'write'): T {
    this.assertSeparate();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const locks = join(dirname(this.directory), 'thread-locks');
    mkdirSync(locks, { recursive: true, mode: 0o700 });
    const lock = new DatabaseSync(join(locks, `${file}.sqlite`));
    try {
      lock.exec('PRAGMA busy_timeout=5000');
      lock.exec(mode === 'read' ? 'PRAGMA query_only=ON; BEGIN; SELECT 1 FROM sqlite_schema'
        : 'BEGIN EXCLUSIVE');
      const result = work();
      lock.exec('COMMIT');
      return result;
    } finally { lock.close(); }
  }
  private available(): boolean {
    if (!this.options.archiveDirectory || !this.assertSeparate()) return false;
    try { return lstatSync(join(this.options.archiveDirectory, '.orca-slack-archive')).isFile(); }
    catch (error) { if (unavailable(error)) return false; throw error; }
  }
  private filename(id: string): string { return `${createHash('sha256').update(id).digest('hex')}.json`; }
  private parse(content: Buffer, filename: string): UnboundThread {
    let value;
    try { value = JSON.parse(content.toString()); } catch { throw new Error('Invalid thread record'); }
    const text = (value: unknown) => typeof value === 'string' && value.length > 0;
    const timestamp = (value: unknown) => typeof value === 'string' && /^\d+(\.\d+)?$/.test(value);
    if (!value || !value.thread || !['id', 'channel', 'threadTs', 'owner'].every(key => text(value.thread[key])) ||
      !timestamp(value.thread.threadTs) ||
      !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 || !Array.isArray(value.messages) ||
      value.messages.some((message: SlackEvent) => !message ||
        !['installationId', 'eventId', 'channel', 'ts', 'user'].every(key => text(message[key as keyof SlackEvent])) ||
        !timestamp(message.ts) || (message.threadTs !== undefined && !timestamp(message.threadTs)) ||
        typeof message.text !== 'string' || message.channel !== value.thread.channel ||
        (message.threadTs ?? message.ts) !== value.thread.threadTs) || this.filename(value.thread.id) !== filename) {
      throw new Error('Invalid thread record');
    }
    return value as UnboundThread;
  }
  private content(directory: string, file: string): Buffer | undefined {
    let regular: boolean;
    try {
      regular = lstatSync(join(directory, file)).isFile();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!regular) throw new Error('Archive verification failed');
    return readFileSync(join(directory, file));
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
    const archive = this.archiveSnapshot(file);
    return { archive: archive.state === 'ready' ? archive.bytes : undefined,
      record: this.merge([...(archive.state === 'ready' && archive.record ? [archive.record] : []),
        ...(local ? [this.parse(local, file)] : [])]) };
  }
  private archiveSnapshot(file: string): ArchiveSnapshot {
    try {
      if (!this.available()) return { state: 'unavailable' };
      const bytes = this.content(this.options.archiveDirectory!, file);
      return { state: 'ready', bytes, record: bytes ? this.parse(bytes, file) : undefined };
    } catch (error) { return { state: unavailable(error) ? 'unavailable' : 'damaged' }; }
  }
  read(id: string): UnboundThread | undefined {
    return this.locked(this.filename(id), () => this.load(id).record, 'read');
  }
  append(thread: Thread, event: SlackEvent, now = Date.now()): UnboundThread {
    const incoming = { thread, messages: [event], updatedAt: now };
    this.parse(Buffer.from(JSON.stringify(incoming)), this.filename(thread.id));
    return this.locked(this.filename(thread.id), () => {
      const saved = this.load(thread.id);
      const record = this.merge([...(saved.record ? [saved.record] : []), incoming])!;
      record.thread = thread;
      this.parse(Buffer.from(JSON.stringify(record)), this.filename(thread.id));
      const local = this.write(record);
      this.removeArchive(thread.id, saved.archive, local);
      return record;
    });
  }
  reactivate(id: string, now = Date.now()): UnboundThread | undefined {
    return this.locked(this.filename(id), () => {
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
    if (!archived) return;
    const file = this.filename(id);
    const current = this.archiveSnapshot(file);
    if (current.state !== 'ready' || !current.bytes?.equals(archived) ||
        !this.content(this.directory, file)?.equals(local)) return;
    try {
      rmSync(join(this.options.archiveDirectory!, file));
      this.sync(this.options.archiveDirectory!);
    } catch (error) { if (!unavailable(error)) throw error; }
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
    return this.archive(now);
  }
  private archive(now: number): ArchiveResult {
    const result: ArchiveResult = { archived: [], retained: [] };
    this.assertSeparate();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const files = new Set(readdirSync(this.directory).filter(file => /^[a-f0-9]{64}\.json$/.test(file)));
    const recovery = new Set<string>();
    let listingAvailable = true;
    try {
      if (this.available()) for (const name of readdirSync(this.options.archiveDirectory!)) {
        const match = /^([a-f0-9]{64}\.json)(\.(?:corrupt|recovery-.+))?$/.exec(name);
        if (match) { files.add(match[1]); if (match[2]) recovery.add(match[1]); }
      }
    } catch (error) { if (!unavailable(error)) throw error; listingAvailable = false; }
    for (const file of files) {
      let id = file;
      let temporary: string | undefined;
      try {
        this.locked(file, () => {
          const source = join(this.directory, file);
          const content = this.content(this.directory, file);
          const record = content ? this.parse(content, file) : undefined;
          id = record?.thread.id ?? file;
          if (recovery.has(file)) throw new Error('Archive requires recovery');
          const snapshot = this.archiveSnapshot(file);
          if (snapshot.state === 'damaged') throw new Error('Invalid archive record');
          if (!record || !content) return;
          if (now - record.updatedAt < this.retention || this.isBound(id)) return;
          if (!this.options.archiveDirectory) throw new Error('Archive is not configured');
          if (!listingAvailable || snapshot.state !== 'ready') throw new Error('Archive is not mounted');
          const destination = join(this.options.archiveDirectory, file);
          const previous = snapshot.bytes;
          const combined = this.merge([...(snapshot.record ? [snapshot.record] : []), record])!;
          if (now - combined.updatedAt < this.retention) return;
          const archived = Buffer.from(JSON.stringify(combined));
          temporary = join(this.options.archiveDirectory, `.${randomUUID()}.tmp`);
          const fd = openSync(temporary, 'wx', 0o600);
          try { writeFileSync(fd, archived); fsyncSync(fd); } finally { closeSync(fd); }
          if (!lstatSync(temporary).isFile() || !readFileSync(temporary).equals(archived)) throw new Error('Archive verification failed');
          if (!this.available()) throw new Error('Archive is not mounted');
          const current = this.content(this.options.archiveDirectory, file);
          if (previous ? !current?.equals(previous) : current !== undefined) throw new Error('Archive changed during archival');
          renameSync(temporary, destination);
          if (!this.content(this.options.archiveDirectory, file)?.equals(archived)) throw new Error('Archive verification failed');
          this.sync(this.options.archiveDirectory);
          if (!this.available() || !this.content(this.directory, file)?.equals(content) ||
              !this.content(this.options.archiveDirectory, file)?.equals(archived)) throw new Error('Thread changed during archival');
          if (this.isBound(id)) return;
          rmSync(source);
          this.sync(this.directory);
          result.archived.push(id);
        });
      } catch (error) {
        result.retained.push({ id, reason: (error as NodeJS.ErrnoException).code ?? (error as Error).message });
      } finally {
        if (temporary) try { rmSync(temporary, { force: true }); }
        catch (error) { if (!unavailable(error)) throw error; }
      }
    }
    return result;
  }
}
