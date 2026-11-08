import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { CliOrca, type Message } from '../src/orca.js';
import { ReportLoop } from '../src/report-loop.js';
import { Store } from '../src/store.js';

class ScriptedOrca {
  history: (Message & { sequence: number; read: boolean })[] = [];
  commands: string[][] = [];
  afterPeek?: () => void;
  afterConsume?: () => void;
  client = new CliOrca(async args => {
    this.commands.push(args);
    const result = args[1] === 'inbox'
      ? { count: Math.min(1000, this.history.length), messages: this.history.slice(-1000).toReversed() }
      : { messages: this.history.filter(row => !row.read).map(({ read, sequence, ...message }) => message) };
    const stdout = JSON.stringify({ ok: true, result });
    if (args[1] === 'check' && !args.includes('--peek')) {
      this.history.forEach(row => { row.read = true; });
      this.afterConsume?.();
    }
    if (args.includes('--peek')) this.afterPeek?.();
    return { stdout };
  });
  add(id: string): void {
    this.history.push({ id, type: 'worker_done', body: `Report ${id}`, payload: '{"outcome":"succeeded"}',
      sequence: this.history.length + 1, read: false });
  }
}
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });

test('report loop persists the whole consuming batch including a message arriving after peek', async () => {
  const store = new Store(':memory:');
  const scripted = new ScriptedOrca();
  const sent: string[] = [];
  scripted.add('first');
  scripted.afterPeek = () => { scripted.add('late'); scripted.afterPeek = undefined; };
  try {
    const loop = new ReportLoop(scripted.client, store, 'run', async message => { sent.push(message.id); });
    await loop.poll();
    expect(sent).toEqual(['first', 'late']);
    expect(store.reports('run').map(row => [row.id, row.sequence, row.state])).toEqual([
      ['first', 1, 'sent'], ['late', 2, 'sent'],
    ]);
  } finally { store.close(); }
});

test.each(['before-peek', 'after-peek', 'after-peek-persist', 'after-consume', 'after-consume-persist',
  'after-inbox', 'after-send', 'after-sent'] as const)('report survives crash at %s and recovery sends at most one duplicate', async crashAt => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-report-'));
  roots.push(root);
  const file = join(root, 'ledger.sqlite');
  const scripted = new ScriptedOrca();
  scripted.add('report');
  const sent: string[] = [];
  const send = async (message: Message) => { sent.push(message.id); };
  let store = new Store(file);
  const loop = new ReportLoop(scripted.client, store, 'run', send, step => {
    if (step === crashAt) throw new Error('Bridge crashed');
  });
  await expect(loop.poll()).rejects.toThrow('Bridge crashed');
  store.close();
  store = new Store(file);
  try {
    const restarted = new ReportLoop(scripted.client, store, 'run', send);
    await restarted.recover();
    await restarted.poll();
    await restarted.recover();
    expect(sent).toEqual(crashAt === 'after-send' ? ['report', 'report'] : ['report']);
    expect(store.reports('run')).toMatchObject([{ id: 'report', sequence: 1, state: 'sent' }]);
  } finally { store.close(); }
});

test('inbox restores a consumed late arrival after crash before the consuming batch is saved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-late-'));
  roots.push(root);
  const file = join(root, 'ledger.sqlite');
  const scripted = new ScriptedOrca();
  scripted.add('first');
  scripted.afterPeek = () => { scripted.add('late'); scripted.afterPeek = undefined; };
  const sent: string[] = [];
  const send = async (message: Message) => { sent.push(message.id); };
  let store = new Store(file);
  await expect(new ReportLoop(scripted.client, store, 'run', send, step => {
    if (step === 'after-consume') throw new Error('Bridge crashed');
  }).poll()).rejects.toThrow('Bridge crashed');
  expect(store.reports('run').map(row => row.id)).toEqual(['first']);
  expect(scripted.history.every(row => row.read)).toBe(true);
  store.close();
  store = new Store(file);
  try {
    await new ReportLoop(scripted.client, store, 'run', send).recover();
    expect(sent).toEqual(['first', 'late']);
  } finally { store.close(); }
});

test.each([
  { count: 999, overlap: false, expected: 'complete' },
  { count: 1000, overlap: true, expected: 'complete' },
  { count: 1000, overlap: false, expected: 'gap' },
])('startup reconciliation with $count rows and overlap=$overlap flags $expected', async ({ count, overlap, expected }) => {
  const store = new Store(':memory:');
  const scripted = new ScriptedOrca();
  for (let i = 0; i < count; i++) scripted.add(`message-${i}`);
  if (overlap) store.persistReports('run', [scripted.history[0]]);
  try {
    expect(await new ReportLoop(scripted.client, store, 'run', async () => {}).reconcile())
      .toEqual({ state: expected, count });
    expect(store.coverage('run')).toEqual({ state: expected, count });
  } finally { store.close(); }
});

test('a known coverage gap stays visible after subsequent overlap with newly recovered rows', async () => {
  const store = new Store(':memory:');
  const scripted = new ScriptedOrca();
  for (let i = 0; i < 1000; i++) scripted.add(`message-${i}`);
  try {
    const loop = new ReportLoop(scripted.client, store, 'run', async () => {});
    await loop.reconcile();
    expect((await loop.reconcile()).state).toBe('gap');
  } finally { store.close(); }
});

test('a rejected send remains pending and later recovery delivers it', async () => {
  const store = new Store(':memory:');
  const scripted = new ScriptedOrca();
  scripted.add('report');
  try {
    await expect(new ReportLoop(scripted.client, store, 'run', async () => { throw new Error('Slack unavailable'); })
      .poll()).rejects.toThrow('Slack unavailable');
    expect(store.reports('run')[0].state).toBe('pending');
    const sent: string[] = [];
    await new ReportLoop(scripted.client, store, 'run', async report => { sent.push(report.id); }).recover();
    expect(sent).toEqual(['report']);
  } finally { store.close(); }
});

test('overlap only with a newer row does not hide the missing oldest history', async () => {
  const store = new Store(':memory:');
  const scripted = new ScriptedOrca();
  for (let i = 0; i < 1000; i++) scripted.add(`message-${i}`);
  store.persistReports('run', [scripted.history[999]]);
  try {
    expect((await new ReportLoop(scripted.client, store, 'run', async () => {}).reconcile()).state).toBe('gap');
  } finally { store.close(); }
});

test('a sequence conflict rolls back a recovered batch instead of discarding a report silently', () => {
  const store = new Store(':memory:');
  try {
    store.persistReports('run', [{ id: 'original', type: 'status', sequence: 5 }]);
    expect(() => store.persistReports('run', [
      { id: 'new', type: 'status', sequence: 6 }, { id: 'original', type: 'status', sequence: 7 },
    ])).toThrow('sequence changed');
    expect(store.reports('run').map(row => row.id)).toEqual(['original']);
  } finally { store.close(); }
});

test('overlapping polls on the sole report consumer do not send a report twice', async () => {
  const store = new Store(':memory:');
  const scripted = new ScriptedOrca();
  scripted.add('report');
  const sent: string[] = [];
  try {
    const loop = new ReportLoop(scripted.client, store, 'run', async report => {
      sent.push(report.id);
      await new Promise(resolve => setImmediate(resolve));
    });
    await Promise.all([loop.poll(), loop.poll(), loop.recover()]);
    expect(sent).toEqual(['report']);
  } finally { store.close(); }
});

test('the oldest message id without its inbox sequence does not establish full-page coverage', async () => {
  const store = new Store(':memory:');
  const scripted = new ScriptedOrca();
  for (let i = 0; i < 1000; i++) scripted.add(`message-${i}`);
  store.persistReports('run', [{ id: 'message-0', type: 'worker_done' }]);
  try {
    expect((await new ReportLoop(scripted.client, store, 'run', async () => {}).reconcile()).state).toBe('gap');
  } finally { store.close(); }
});

test('an aged-out saved report without a sequence is delivered without blocking the pending inbox page', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-aged-report-'));
  roots.push(root);
  const file = join(root, 'ledger.sqlite');
  const scripted = new ScriptedOrca();
  scripted.add('aged-report');
  let store = new Store(file);
  await expect(new ReportLoop(scripted.client, store, 'run', async () => {}, step => {
    if (step === 'after-consume-persist') throw new Error('Bridge crashed');
  }).poll()).rejects.toThrow('Bridge crashed');
  store.close();
  for (let i = 0; i < 1000; i++) scripted.add(`new-${i}`);
  store = new Store(file);
  const sent: string[] = [];
  try {
    const loop = new ReportLoop(scripted.client, store, 'run', async report => { sent.push(report.id); });
    await loop.recover();
    await loop.recover();
    expect(sent).toHaveLength(1001);
    expect(new Set(sent).size).toBe(1001);
    expect(sent).toContain('aged-report');
    expect(store.reports('run').find(row => row.id === 'aged-report')).toMatchObject({ state: 'sent' });
    expect(store.coverage('run')?.state).toBe('gap');
  } finally { store.close(); }
});

test('initialized idle polls do not reread the inbox history page', async () => {
  const store = new Store(':memory:');
  const scripted = new ScriptedOrca();
  try {
    const loop = new ReportLoop(scripted.client, store, 'run', async () => {});
    await loop.recover();
    await loop.poll();
    await loop.poll();
    expect(scripted.commands.filter(args => args[1] === 'inbox')).toHaveLength(1);
  } finally { store.close(); }
});

test.each([1000, 1001])('a fully persisted burst of %s reports preserves established complete coverage', async count => {
  const store = new Store(':memory:');
  const scripted = new ScriptedOrca();
  scripted.add('baseline');
  const sent: string[] = [];
  try {
    const loop = new ReportLoop(scripted.client, store, 'run', async report => { sent.push(report.id); });
    await loop.poll();
    for (let i = 0; i < count; i++) scripted.add(`burst-${i}`);
    expect(await loop.poll()).toEqual({ state: 'complete', count: 1000 });
    expect(sent).toHaveLength(count + 1);
    expect(store.coverage('run')?.state).toBe('complete');
  } finally { store.close(); }
});

test('a replacement consumer still detects a startup gap despite fresh persisted burst ids', async () => {
  const store = new Store(':memory:');
  const scripted = new ScriptedOrca();
  scripted.add('baseline');
  try {
    await new ReportLoop(scripted.client, store, 'run', async () => {}).poll();
    for (let i = 0; i < 1000; i++) scripted.add(`new-${i}`);
    const restarted = new ReportLoop(scripted.client, store, 'run', async () => {});
    expect((await restarted.poll()).state).toBe('gap');
  } finally { store.close(); }
});

test('idle polls retry a sequenced pending delivery without rereading inbox history', async () => {
  const store = new Store(':memory:');
  const scripted = new ScriptedOrca();
  scripted.add('report');
  let available = false;
  const sent: string[] = [];
  try {
    const loop = new ReportLoop(scripted.client, store, 'run', async report => {
      if (!available) throw new Error('Slack unavailable');
      sent.push(report.id);
    });
    await expect(loop.poll()).rejects.toThrow('Slack unavailable');
    available = true;
    await loop.poll();
    expect(sent).toEqual(['report']);
    expect(scripted.commands.filter(args => args[1] === 'inbox')).toHaveLength(1);
  } finally { store.close(); }
});

test('a lost consuming receipt invalidates live coverage evidence before a later burst', async () => {
  const store = new Store(':memory:');
  const scripted = new ScriptedOrca();
  scripted.add('baseline');
  try {
    const loop = new ReportLoop(scripted.client, store, 'run', async () => {});
    await loop.poll();
    scripted.add('peeked');
    scripted.afterPeek = () => { scripted.add('lost-late'); scripted.afterPeek = undefined; };
    scripted.afterConsume = () => { scripted.afterConsume = undefined; throw new Error('Consuming receipt lost'); };
    await expect(loop.poll()).rejects.toThrow('Consuming receipt lost');
    for (let i = 0; i < 1000; i++) scripted.add(`later-${i}`);
    expect((await loop.poll()).state).toBe('gap');
  } finally { store.close(); }
});
