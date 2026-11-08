import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { UnboundThreads } from '../src/unbound-threads.js';
import type { SlackEvent, Thread } from '../src/store.js';
import { makeArchive } from './archive-volume.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const day = 86_400_000;
const thread: Thread = { id: 'thread', channel: 'C1', threadTs: '1.0', owner: 'U1' };
const event: SlackEvent = { installationId: 'app', eventId: 'original', channel: 'C1', ts: '1.0', user: 'U1', text: 'Original' };
const reply: SlackEvent = { ...event, eventId: 'reply', ts: '2.0', threadTs: '1.0', text: 'A new reply' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'thread-reliability-'));
  roots.push(root);
  const archiveDirectory = join(root, 'archive');
  makeArchive(archiveDirectory);
  writeFileSync(join(archiveDirectory, '.orca-slack-archive'), '');
  const threads = new UnboundThreads({ checkout: root, archiveDirectory });
  threads.append(thread, event, day);
  const [file] = readdirSync(join(root, 'data', 'threads'));
  return { root, archiveDirectory, threads, file, local: join(root, 'data', 'threads', file) };
}
const files = (directory: string) => readdirSync(directory).filter(name => name !== '.orca-slack-archive');

test.each([
  ['damaged', true], ['damaged', false], ['directory', true], ['directory', false], ['symlink', true], ['symlink', false],
] as const)('SF1 %s archives preserve local reads and replies with prior local record %s', (kind, hasLocal) => {
  const { root, archiveDirectory, threads, file, local } = fixture();
  const archived = join(archiveDirectory, file);
  if (kind === 'damaged') writeFileSync(archived, '{"messages":');
  else if (kind === 'directory') mkdirSync(archived);
  else symlinkSync(join(root, 'missing'), archived);
  if (!hasLocal) rmSync(local);
  expect(threads.read(thread.id)?.messages).toEqual(hasLocal ? [event] : undefined);
  const expected = hasLocal ? [event, reply] : [reply];
  expect(threads.append(thread, reply, 2 * day).messages).toEqual(expected);
  expect(threads.reactivate(thread.id, 3 * day)?.messages).toEqual(expected);
  for (let run = 0; run < 2; run++) {
    expect(threads.archiveExpired(40 * day)).toEqual({ archived: [],
      retained: [{ id: thread.id, reason: 'Invalid archive record' }] });
  }
  expect(files(archiveDirectory)).toEqual([file]);
  expect(JSON.parse(readFileSync(local, 'utf8')).messages).toEqual(expected);
  if (kind === 'damaged') expect(readFileSync(archived, 'utf8')).toBe('{"messages":');
  else expect(fs.lstatSync(archived)[kind === 'directory' ? 'isDirectory' : 'isSymbolicLink']()).toBe(true);
});

test.each([true, false])('SF1 legacy recovery history is reported without a clean archive, local record %s', hasLocal => {
  const { archiveDirectory, threads, file, local } = fixture();
  const prior = readFileSync(local);
  const recovery = `${file}.recovery-prior`;
  writeFileSync(join(archiveDirectory, recovery), prior);
  if (!hasLocal) rmSync(local);
  expect(threads.archiveExpired(40 * day)).toEqual({ archived: [],
    retained: [{ id: hasLocal ? thread.id : file, reason: 'Archive requires recovery' }] });
  expect(files(archiveDirectory)).toEqual([recovery]);
  expect(readFileSync(join(archiveDirectory, recovery))).toEqual(prior);
});

test('SF2 a marked local archive is available without a different device number', () => {
  const root = mkdtempSync(join(tmpdir(), 'thread-marker-'));
  roots.push(root);
  const archiveDirectory = join(root, 'archive');
  mkdirSync(archiveDirectory);
  writeFileSync(join(archiveDirectory, '.orca-slack-archive'), '');
  const threads = new UnboundThreads({ checkout: root, archiveDirectory });
  threads.append(thread, event, day);
  expect(threads.archiveExpired(32 * day)).toEqual({ archived: [thread.id], retained: [] });
  expect(threads.read(thread.id)?.messages).toEqual([event]);
});

test('SF2 an unmarked archive on another filesystem stays unavailable', () => {
  const { root, archiveDirectory, threads } = fixture();
  rmSync(join(archiveDirectory, '.orca-slack-archive'));
  expect(fs.statSync(archiveDirectory).dev).not.toBe(fs.statSync(root).dev);
  expect(threads.archiveExpired(32 * day)).toEqual({ archived: [],
    retained: [{ id: thread.id, reason: 'Archive is not mounted' }] });
  expect(files(archiveDirectory)).toEqual([]);
});

test.each(['ENOENT', 'ENOTDIR', 'ESTALE', 'EIO', 'ETIMEDOUT', 'ENOTCONN', 'EHOSTDOWN', 'EHOSTUNREACH',
  'ENETDOWN', 'ENETUNREACH', 'EACCES'])('SF2 archive read error %s still persists the reply locally', code => {
  const { archiveDirectory, threads, file, local } = fixture();
  writeFileSync(join(archiveDirectory, file), readFileSync(local));
  const read = fs.readFileSync;
  let faults = 0;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof path === 'string' && path.startsWith(archiveDirectory)) {
      faults++;
      throw Object.assign(new Error('Share unavailable'), { code });
    }
    return Reflect.apply(read, fs, [path, ...args]);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  expect(threads.append(thread, reply, 2 * day).messages).toEqual([event, reply]);
  expect(faults).toBeGreaterThan(0);
  expect(JSON.parse(readFileSync(local, 'utf8')).messages).toEqual([event, reply]);
});

test('SF2 archive path lookup failure cannot block a local append', () => {
  const { archiveDirectory, threads, local } = fixture();
  const canonical = fs.realpathSync;
  vi.spyOn(fs, 'realpathSync').mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
    if (typeof path === 'string' && path.startsWith(archiveDirectory)) {
      throw Object.assign(new Error('Stale share'), { code: 'ESTALE' });
    }
    return Reflect.apply(canonical, fs, [path, ...args]);
  }) as typeof fs.realpathSync);
  syncBuiltinESMExports();
  expect(threads.append(thread, reply, 2 * day).messages).toEqual([event, reply]);
  expect(JSON.parse(readFileSync(local, 'utf8')).messages).toEqual([event, reply]);
});

test('SF2 failed archive path resolution cannot bypass storage separation', () => {
  const { root, archiveDirectory, threads, local } = fixture();
  rmSync(archiveDirectory);
  symlinkSync(join(root, 'data', 'threads'), archiveDirectory);
  writeFileSync(join(archiveDirectory, '.orca-slack-archive'), '');
  const canonical = fs.realpathSync;
  vi.spyOn(fs, 'realpathSync').mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
    if (typeof path === 'string' && path.startsWith(archiveDirectory)) {
      throw Object.assign(new Error('Stale share'), { code: 'ESTALE' });
    }
    return Reflect.apply(canonical, fs, [path, ...args]);
  }) as typeof fs.realpathSync);
  syncBuiltinESMExports();
  expect(threads.archiveExpired(40 * day)).toEqual({ archived: [],
    retained: [{ id: thread.id, reason: 'Archive is not mounted' }] });
  expect(JSON.parse(readFileSync(local, 'utf8')).messages).toEqual([event]);
});

test('SF2 an archive read ENOENT after lookup cannot overwrite unseen history', () => {
  const { archiveDirectory, threads, file, local } = fixture();
  const destination = join(archiveDirectory, file);
  const older = { ...reply, eventId: 'archived-only', ts: '1.5', text: 'Only in the archive' };
  const prior = JSON.stringify({ thread, messages: [older], updatedAt: day });
  writeFileSync(destination, prior);
  const read = fs.readFileSync;
  const fault = vi.spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (path === destination) throw Object.assign(new Error('Read unavailable after lookup'), { code: 'ENOENT' });
    return Reflect.apply(read, fs, [path, ...args]);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  const result = threads.archiveExpired(40 * day);
  fault.mockRestore();
  syncBuiltinESMExports();
  expect(result.archived).toEqual([]);
  expect(readFileSync(destination, 'utf8')).toBe(prior);
  expect(JSON.parse(readFileSync(local, 'utf8')).messages).toEqual([event]);
});

test.each(['root', 'reply'])('SF4 malformed %s thread timestamps are rejected at parsing', field => {
  const { threads, local } = fixture();
  const record = JSON.parse(readFileSync(local, 'utf8'));
  record.thread.threadTs = '1.2.3';
  if (field === 'root') record.messages[0].ts = '1.2.3';
  else record.messages[0].threadTs = '1.2.3';
  writeFileSync(local, JSON.stringify(record));
  expect(() => threads.read(thread.id)).toThrow('Invalid thread record');
});

test.each(['invalid', '1.2.3', '-1', '0x10', '1e3'])('SF4 malformed stored timestamp %s is rejected at parsing', ts => {
  const { threads, local } = fixture();
  const record = JSON.parse(readFileSync(local, 'utf8'));
  record.messages[0] = { ...event, ts, threadTs: '1.0' };
  writeFileSync(local, JSON.stringify(record));
  expect(() => threads.read(thread.id)).toThrow('Invalid thread record');
});

test('SF4 malformed incoming timestamps produce a validation error before sorting', () => {
  const { threads } = fixture();
  expect(() => threads.append(thread, { ...reply, ts: 'invalid' }, 2 * day)).toThrow('Invalid thread record');
  expect(() => threads.append({ ...thread, threadTs: 'invalid' }, { ...reply, threadTs: 'invalid' }, 2 * day))
    .toThrow('Invalid thread record');
});

test('SF4 a backward clock keeps the callers latest thread metadata', () => {
  const { threads } = fixture();
  const latest = { ...thread, owner: 'U2', linearTicket: 'ENG-2' };
  const record = threads.append(latest, reply, 0);
  expect(record.thread).toEqual(latest);
  expect(record.updatedAt).toBe(day);
  expect(record.messages).toEqual([event, reply]);
});

test('SF3 a slow archive record cannot lock out another thread', async () => {
  const { root, archiveDirectory, threads } = fixture();
  const other = { ...thread, id: 'other', threadTs: '3.0' };
  const otherEvent = { ...event, eventId: 'other', ts: '3.0' };
  threads.append(other, otherEvent, 200 * day);
  const module = join(root, 'unbound.mjs');
  writeFileSync(module, transpileModule(readFileSync(new URL('../src/unbound-threads.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2024 } }).outputText);
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const [module, checkout, archiveDirectory] = process.argv.slice(1);
    const open = fs.openSync, sync = fs.fsyncSync;
    let slow;
    fs.openSync = (...args) => {
      const fd = open(...args);
      if (String(args[0]).startsWith(archiveDirectory) && args[1] === 'wx') slow = fd;
      return fd;
    };
    fs.fsyncSync = fd => {
      if (fd === slow) {
        console.log('copy-started');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
        slow = undefined;
      }
      return sync(fd);
    };
    syncBuiltinESMExports();
    const { UnboundThreads } = await import(module);
    new UnboundThreads({ checkout, archiveDirectory }).archiveExpired(100 * 86400000);
  `;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, module, root, archiveDirectory]);
  let entered = false, ready!: () => void, error = '';
  const copying = new Promise<void>(resolve => { ready = resolve; });
  child.stdout.on('data', () => { entered = true; ready(); });
  child.stderr.on('data', data => { error += data; });
  const done = new Promise<number | null>(resolve => { child.on('close', code => { ready(); resolve(code); }); });
  const timeout = setTimeout(() => child.kill(), 15_000);
  let result, failure;
  try {
    await copying;
    try {
      const followup = { ...otherEvent, eventId: 'next', ts: '4.0', threadTs: '3.0' };
      result = threads.append(other, followup, 201 * day);
      expect(threads.read(other.id)?.messages).toEqual([otherEvent, followup]);
    } catch (caught) { failure = caught; }
    expect(await done, error).toBe(0);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
    await done;
  }
  expect(entered).toBe(true);
  expect(failure).toBeUndefined();
  expect(result?.messages).toHaveLength(2);
}, 20_000);
