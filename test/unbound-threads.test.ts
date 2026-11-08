import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { UnboundThreads } from '../src/unbound-threads.js';
import { Store, type SlackEvent, type Thread } from '../src/store.js';
import { Bridge } from '../src/slack.js';
import { CliOrca } from '../src/orca.js';
import { LeadCli } from '../src/lead-orca.js';
import { Leads } from '../src/leads.js';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { archiveFiles, makeArchive } from './archive-volume.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const thread: Thread = { id: '["C1","1.0"]', channel: 'C1', threadTs: '1.0', owner: 'U1' };
const event: SlackEvent = { installationId: 'app', eventId: 'event-1', channel: 'C1', ts: '1.0',
  user: 'U1', text: '<@BOT> Discuss an idea without a repository.\n保留原文。' };
const day = 86_400_000;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-unbound-'));
  roots.push(root);
  return { root, threads: new UnboundThreads({ checkout: root }) };
}

test('an unbound thread is written under data/threads and git check-ignore excludes it', () => {
  const { root, threads } = fixture();
  execFileSync('git', ['init', '--initial-branch=main', root], { stdio: 'pipe' });
  copyFileSync(new URL('../.gitignore', import.meta.url), join(root, '.gitignore'));
  threads.append(thread, event, day);
  const [file] = readdirSync(join(root, 'data', 'threads'));
  expect(execFileSync('git', ['-C', root, 'check-ignore', `data/threads/${file}`], { encoding: 'utf8' }).trim())
    .toBe(`data/threads/${file}`);
  expect(execFileSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }))
    .not.toContain('data/threads');
  expect(new UnboundThreads({ checkout: root }).read(thread.id))
    .toEqual({ thread, messages: [event], updatedAt: day });
});

test.each([undefined, 2])('retention %s days copies and verifies the transcript before deleting the local record', retentionDays => {
  const { root } = fixture();
  const archiveDirectory = join(root, 'archive');
  makeArchive(archiveDirectory);
  const threads = new UnboundThreads({ checkout: root, archiveDirectory, retentionDays });
  threads.append(thread, event, day);
  const [file] = readdirSync(join(root, 'data', 'threads'));
  const original = readFileSync(join(root, 'data', 'threads', file));
  const cutoff = day + (retentionDays ?? 30) * day;
  expect(threads.archiveExpired(cutoff - 1)).toEqual({ archived: [], retained: [] });
  expect(threads.archiveExpired(cutoff)).toEqual({ archived: [thread.id], retained: [] });
  expect(readFileSync(join(archiveDirectory, file))).toEqual(original);
  expect(existsSync(join(root, 'data', 'threads', file))).toBe(false);
  expect(threads.read(thread.id)).toEqual({ thread, messages: [event], updatedAt: day });
});

test('a failed archive write leaves the local transcript intact without publishing a partial record', () => {
  const { root } = fixture();
  const archiveDirectory = join(root, 'archive');
  makeArchive(archiveDirectory);
  const threads = new UnboundThreads({ checkout: root, archiveDirectory });
  const large = { ...event, text: 'x'.repeat(40 * 1024 * 1024) };
  threads.append(thread, large, day);
  const [file] = readdirSync(join(root, 'data', 'threads'));
  const local = join(root, 'data', 'threads', file);
  expect(threads.archiveExpired(32 * day)).toEqual({ archived: [],
    retained: [{ id: thread.id, reason: 'ENOSPC' }] });
  expect(JSON.parse(readFileSync(local, 'utf8'))).toEqual({ thread, messages: [large], updatedAt: day });
  expect(archiveFiles(archiveDirectory)).toEqual([]);
}, 15_000);

test('an absent archive keeps the local record and retries when the directory becomes available', () => {
  const { root } = fixture();
  const archiveDirectory = join(root, 'archive');
  const threads = new UnboundThreads({ checkout: root, archiveDirectory });
  threads.append(thread, event, day);
  expect(threads.archiveExpired(32 * day)).toEqual({ archived: [], retained: [{ id: thread.id, reason: 'Archive is not mounted' }] });
  expect(existsSync(archiveDirectory)).toBe(false);
  expect(threads.read(thread.id)?.messages).toEqual([event]);
  makeArchive(archiveDirectory);
  expect(threads.archiveExpired(33 * day)).toEqual({ archived: [thread.id], retained: [] });
  expect(readdirSync(join(root, 'data', 'threads'))).toEqual([]);
});

test('reactivating an archived thread restores all content before accepting a new message', () => {
  const { root } = fixture();
  const archiveDirectory = join(root, 'archive');
  makeArchive(archiveDirectory);
  let threads = new UnboundThreads({ checkout: root, archiveDirectory });
  threads.append(thread, event, day);
  threads.archiveExpired(32 * day);
  threads = new UnboundThreads({ checkout: root, archiveDirectory });
  expect(threads.reactivate(thread.id, 33 * day)).toEqual({ thread, messages: [event], updatedAt: 33 * day });
  expect(archiveFiles(archiveDirectory)).toEqual([]);
  expect(new UnboundThreads({ checkout: root }).read(thread.id)?.messages).toEqual([event]);
  const followup = { ...event, eventId: 'event-2', ts: '2.0', threadTs: '1.0', text: 'Continue this idea' };
  threads.append(thread, followup, 33 * day);
  expect(threads.read(thread.id)?.messages).toEqual([event, followup]);
  expect(threads.archiveExpired(64 * day)).toEqual({ archived: [thread.id], retained: [] });
  expect(threads.read(thread.id)?.messages).toEqual([event, followup]);
});

test.each([0, -1, NaN, Infinity])('invalid retention %s cannot expire any records', retentionDays => {
  const { root } = fixture();
  expect(() => new UnboundThreads({ checkout: root, retentionDays })).toThrow('Invalid retention');
});

test('an archive configured inside local thread storage is rejected instead of deleting the only copy', () => {
  const { root } = fixture();
  expect(() => new UnboundThreads({ checkout: root, archiveDirectory: join(root, 'data', 'threads') }))
    .toThrow('Archive must be separate');
});

test('invalid transcript data cannot be read, expired, or overwritten by reactivation', () => {
  const { root, threads } = fixture();
  threads.append(thread, event, day);
  const [file] = readdirSync(join(root, 'data', 'threads'));
  const local = join(root, 'data', 'threads', file);
  const damaged = JSON.stringify({ thread, messages: [], updatedAt: 'yesterday' });
  writeFileSync(local, damaged);
  expect(() => threads.reactivate(thread.id, 33 * day)).toThrow('Invalid thread record');
  expect(threads.archiveExpired(33 * day)).toEqual({ archived: [],
    retained: [{ id: file, reason: 'Invalid thread record' }] });
  expect(readFileSync(local, 'utf8')).toBe(damaged);
});

test('appending directly to an archived thread keeps peer text and deduplicates Slack redelivery', () => {
  const { root } = fixture();
  const archiveDirectory = join(root, 'archive');
  makeArchive(archiveDirectory);
  const threads = new UnboundThreads({ checkout: root, archiveDirectory });
  threads.append(thread, event, day);
  threads.archiveExpired(32 * day);
  const peer = { ...event, eventId: 'peer', ts: '2.0', threadTs: '1.0', user: 'U2', text: 'A peer note' };
  threads.append(thread, peer, 33 * day);
  threads.append(thread, { ...peer, eventId: 'dual-event' }, 33 * day);
  expect(threads.read(thread.id)?.messages).toEqual([event, peer]);
  expect(archiveFiles(archiveDirectory)).toEqual([]);
});

test('without archive configuration an expired record stays local', () => {
  const { threads } = fixture();
  threads.append(thread, event, day);
  expect(threads.archiveExpired(32 * day)).toEqual({ archived: [],
    retained: [{ id: thread.id, reason: 'Archive is not configured' }] });
  expect(threads.read(thread.id)?.messages).toEqual([event]);
});

test('an archive symlink to the local record cannot pass copy verification and lose the transcript', () => {
  const { root } = fixture();
  const archiveDirectory = join(root, 'archive');
  makeArchive(archiveDirectory);
  const threads = new UnboundThreads({ checkout: root, archiveDirectory });
  threads.append(thread, event, day);
  const [file] = readdirSync(join(root, 'data', 'threads'));
  const local = join(root, 'data', 'threads', file);
  symlinkSync(local, join(archiveDirectory, file));
  expect(threads.archiveExpired(32 * day)).toEqual({ archived: [],
    retained: [{ id: thread.id, reason: 'Invalid archive record' }] });
  expect(JSON.parse(readFileSync(local, 'utf8')).messages).toEqual([event]);
  expect(existsSync(local)).toBe(true);
});

test('Bridge persists authorized unbound messages and reactivates the transcript on a thread reply', async () => {
  const { root } = fixture();
  const archiveDirectory = join(root, 'archive');
  makeArchive(archiveDirectory);
  const threads = new UnboundThreads({ checkout: root, archiveDirectory });
  const store = new Store(':memory:');
  const commands: string[][] = [];
  const refused: string[] = [];
  const orca = new CliOrca(async args => { commands.push(args); return { stdout: '{"ok":true,"result":{}}' }; });
  const slack = { refuse: async (_: string, user: string) => { refused.push(user); }, ownerAction: async () => {} };
  try {
    const bridge = new Bridge(orca, slack, store, ['U1', 'U2'], 'BOT', undefined, undefined, threads);
    await bridge.event(event);
    expect(threads.read(thread.id)?.messages).toEqual([event]);
    const original = threads.read(thread.id)!;
    expect(threads.archiveExpired(original.updatedAt + 31 * day).archived).toEqual([thread.id]);
    const reply = { ...event, eventId: 'reply', ts: '2.0', threadTs: '1.0', text: 'Keep the original context' };
    await bridge.event(reply);
    await bridge.event({ ...reply, eventId: 'dual-reply' });
    await bridge.event({ ...reply, eventId: 'outsider', ts: '3.0', user: 'OUTSIDER' });
    expect(threads.read(thread.id)?.messages).toEqual([event, reply]);
    expect(archiveFiles(archiveDirectory)).toEqual([]);
    expect(refused).toEqual(['OUTSIDER']);
    expect(commands).toEqual([]);
    store.saveWorktree({ id: 'tree', threadId: thread.id, repository: 'example/web', branch: 'feat/idea' });
    await bridge.event({ ...reply, eventId: 'bound', ts: '4.0', text: 'Now the repository owns this work' });
    expect(threads.read(thread.id)?.messages).toEqual([event, reply]);
  } finally { store.close(); }
});

test.each(['read', 'append', 'reactivate'] as const)('B2 %s merges archived history with replies received while offline', operation => {
  const { root } = fixture();
  const archiveDirectory = join(root, 'archive');
  makeArchive(archiveDirectory);
  const threads = new UnboundThreads({ checkout: root, archiveDirectory });
  threads.append(thread, event, day);
  threads.archiveExpired(32 * day);
  const offline = join(root, 'offline');
  renameSync(archiveDirectory, offline);
  mkdirSync(archiveDirectory);
  const reply = { ...event, eventId: 'reply', ts: '2.0', threadTs: '1.0', text: 'An offline reply' };
  threads.append({ ...thread, owner: 'U2' }, reply, 33 * day);
  expect(archiveFiles(archiveDirectory)).toEqual([]);
  rmSync(archiveDirectory, { recursive: true });
  renameSync(offline, archiveDirectory);
  if (operation === 'append') threads.append({ ...thread, owner: 'U2' }, { ...reply, eventId: 'dual-reply' }, 34 * day);
  if (operation === 'reactivate') threads.reactivate(thread.id, 34 * day);
  expect(threads.read(thread.id)?.messages).toEqual([event, reply]);
  expect(threads.read(thread.id)?.thread.owner).toBe('U2');
});

test('B3 an interrupted archive remains visible and retained until repaired', () => {
  const { root } = fixture();
  const archiveDirectory = join(root, 'archive');
  makeArchive(archiveDirectory);
  const threads = new UnboundThreads({ checkout: root, archiveDirectory });
  threads.append(thread, event, day);
  const [file] = readdirSync(join(root, 'data', 'threads'));
  const incomplete = '{"thread":';
  writeFileSync(join(archiveDirectory, file), incomplete);
  expect(threads.archiveExpired(32 * day)).toEqual({ archived: [],
    retained: [{ id: thread.id, reason: 'Invalid archive record' }] });
  expect(threads.read(thread.id)?.messages).toEqual([event]);
  expect(readFileSync(join(archiveDirectory, file), 'utf8')).toBe(incomplete);
  expect(archiveFiles(archiveDirectory)).toEqual([file]);
  writeFileSync(join(archiveDirectory, file), readFileSync(join(root, 'data', 'threads', file)));
  expect(threads.archiveExpired(33 * day)).toEqual({ archived: [thread.id], retained: [] });
});

test('B3 retention merges an older valid archive before replacing it', () => {
  const { root } = fixture();
  const archiveDirectory = join(root, 'archive');
  makeArchive(archiveDirectory);
  const threads = new UnboundThreads({ checkout: root, archiveDirectory });
  threads.append(thread, event, day);
  threads.archiveExpired(32 * day);
  const offline = join(root, 'offline');
  renameSync(archiveDirectory, offline);
  const reply = { ...event, eventId: 'reply', ts: '2.0', threadTs: '1.0', text: 'A later reply' };
  threads.append(thread, reply, 33 * day);
  renameSync(offline, archiveDirectory);
  expect(threads.archiveExpired(64 * day).archived).toEqual([thread.id]);
  expect(threads.read(thread.id)?.messages).toEqual([event, reply]);
});

test('B4 an unmounted local directory stub never receives archive data', () => {
  const { root } = fixture();
  const archiveDirectory = join(root, 'mount-stub');
  mkdirSync(archiveDirectory);
  const threads = new UnboundThreads({ checkout: root, archiveDirectory });
  threads.append(thread, event, day);
  expect(threads.archiveExpired(32 * day)).toEqual({ archived: [],
    retained: [{ id: thread.id, reason: 'Archive is not mounted' }] });
  expect(archiveFiles(archiveDirectory)).toEqual([]);
  expect(threads.read(thread.id)?.messages).toEqual([event]);
});

test('S2 a freshly bound thread is excluded from the unbound retention sweep', () => {
  const { root } = fixture();
  const archiveDirectory = join(root, 'archive');
  makeArchive(archiveDirectory);
  const store = new Store(':memory:');
  try {
    const threads = new UnboundThreads({ checkout: root, archiveDirectory,
      isBound: id => store.worktrees(id).length > 0 });
    threads.append(thread, event, day);
    store.saveThread(thread);
    store.saveWorktree({ id: 'tree', threadId: thread.id, repository: 'example/web', branch: 'feat/idea' });
    expect(threads.archiveExpired(32 * day)).toEqual({ archived: [], retained: [] });
    expect(threads.read(thread.id)?.messages).toEqual([event]);
    expect(archiveFiles(archiveDirectory)).toEqual([]);
  } finally { store.close(); }
});

test.each(['parent-alias', 'dangling-alias', 'archive-child', 'archive-parent', 'archive-root'])('S3 rejects overlapping storage through %s', mode => {
  const { root } = fixture();
  const local = join(root, 'data', 'threads');
  let archiveDirectory: string;
  if (mode === 'parent-alias') {
    symlinkSync(root, join(root, 'alias'));
    archiveDirectory = join(root, 'alias', 'data', 'threads');
  } else if (mode === 'dangling-alias') {
    archiveDirectory = join(root, 'archive');
    symlinkSync(local, archiveDirectory);
  } else archiveDirectory = mode === 'archive-child' ? join(local, 'archive')
    : mode === 'archive-root' ? parse(root).root : join(root, 'data');
  expect(() => new UnboundThreads({ checkout: root, archiveDirectory })).toThrow('Archive must be separate');
});

test('S4 a corrupt record is retained without blocking another expired thread', () => {
  const { root } = fixture();
  const archiveDirectory = join(root, 'archive');
  makeArchive(archiveDirectory);
  const threads = new UnboundThreads({ checkout: root, archiveDirectory });
  threads.append(thread, event, day);
  const [damaged] = readdirSync(join(root, 'data', 'threads'));
  writeFileSync(join(root, 'data', 'threads', damaged), 'broken JSON');
  const other = { ...thread, id: 'other', threadTs: '2.0' };
  threads.append(other, { ...event, eventId: 'other', ts: '2.0' }, day);
  const result = threads.archiveExpired(32 * day);
  expect(result.archived).toEqual(['other']);
  expect(result.retained).toEqual([{ id: damaged, reason: 'Invalid thread record' }]);
  expect(readFileSync(join(root, 'data', 'threads', damaged), 'utf8')).toBe('broken JSON');
});

test('S5 Bridge composes lead routing and unbound persistence without a positional collision', async () => {
  const { root, threads } = fixture();
  const store = new Store(':memory:');
  const orca = new LeadCli(async () => ({ stdout: '{"ok":true,"result":{}}' }));
  const leads = new Leads(orca, store, { runId: 'run', repositories: [], botId: 'BOT', agent: 'codex' });
  try {
    const bridge = new Bridge(orca, { refuse: async () => {}, ownerAction: async () => {} },
      store, ['U1'], 'BOT', undefined, leads, threads);
    await bridge.event(event);
    expect(store.routingSamples(thread.id)).toHaveLength(1);
    expect(new UnboundThreads({ checkout: root }).read(thread.id)?.messages).toEqual([event]);
  } finally { store.close(); }
});

test('S2 Bridge observes later binding before retention without another Slack event', async () => {
  const { root } = fixture();
  const archiveDirectory = join(root, 'archive');
  makeArchive(archiveDirectory);
  const threads = new UnboundThreads({ checkout: root, archiveDirectory });
  const store = new Store(':memory:');
  const orca = new CliOrca(async () => ({ stdout: '{"ok":true,"result":{}}' }));
  try {
    const bridge = new Bridge(orca, { refuse: async () => {}, ownerAction: async () => {} },
      store, ['U1'], 'BOT', undefined, undefined, threads);
    await bridge.event(event);
    const cutoff = threads.read(thread.id)!.updatedAt + 31 * day;
    store.saveWorktree({ id: 'tree', threadId: thread.id, repository: 'example/web', branch: 'feat/idea' });
    expect(threads.archiveExpired(cutoff)).toEqual({ archived: [], retained: [] });
    expect(archiveFiles(archiveDirectory)).toEqual([]);
  } finally { store.close(); }
});

test('S1 concurrent retention and independent writers preserve every acknowledged message', async () => {
  const { root } = fixture();
  const archiveDirectory = join(root, 'archive');
  makeArchive(archiveDirectory);
  const module = join(root, 'unbound.mjs');
  writeFileSync(module, transpileModule(readFileSync(new URL('../src/unbound-threads.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2024 } }).outputText);
  const script = `
    import { once } from 'node:events';
    const { UnboundThreads } = await import(process.argv[1]);
    const [checkout, archiveDirectory, mode] = process.argv.slice(2);
    const threads = new UnboundThreads({ checkout, archiveDirectory });
    const thread = { id: '["C1","1.0"]', channel: 'C1', threadTs: '1.0', owner: 'U1' };
    console.log('ready');
    await once(process.stdin, 'data');
    for (let i = 0; i < 60; i++) {
      if (mode === 'retention') threads.archiveExpired(100 * 86400000);
      else threads.append(thread, { installationId: 'app', eventId: mode + i, channel: 'C1',
        ts: mode + '.' + String(i).padStart(6, '0'), threadTs: '1.0', user: 'U1', text: mode + i }, 86400000);
    }
  `;
  const processes = ['2', '3', 'retention'].map(mode => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, module, root, archiveDirectory, mode]);
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    let error = '';
    child.stdout.on('data', () => ready());
    child.stderr.on('data', data => { error += data; });
    const done = new Promise<{ code: number | null; error: string }>(resolve => {
      child.on('close', code => { ready(); resolve({ code, error }); });
    });
    return { child, started, done };
  });
  const timeout = setTimeout(() => { for (const process of processes) process.child.kill(); }, 20_000);
  let results;
  try {
    await Promise.all(processes.map(process => process.started));
    for (const process of processes) process.child.stdin.end('go');
    results = await Promise.all(processes.map(process => process.done));
  } finally {
    clearTimeout(timeout);
    for (const process of processes) if (process.child.exitCode === null) process.child.kill();
    await Promise.all(processes.map(process => process.done));
  }
  expect(results.map(result => result.code), results.map(result => result.error).join('\n')).toEqual([0, 0, 0]);
  const record = new UnboundThreads({ checkout: root, archiveDirectory }).read(thread.id)!;
  expect(record.messages).toHaveLength(120);
  expect(new Set(record.messages.map(message => message.eventId)).size).toBe(120);
}, 30_000);
