import { afterEach, expect, test, vi } from 'vitest';
import { Store } from '../src/store.js';
import { PrPoller } from '../src/pr-poller.js';
import type { RunCommand } from '../src/commands.js';

const stores: Store[] = [];
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) store.close(); });
function ledger(): Store {
  const store = new Store(':memory:');
  stores.push(store);
  store.saveThread({ id: 'thread', channel: 'C1', threadTs: '1', owner: 'U1' });
  store.saveWorktree({ id: 'tree', threadId: 'thread', repository: 'example/web', branch: 'feat/export' });
  return store;
}
const open = { number: 12, url: 'https://github.com/example/web/pull/12', state: 'OPEN', headRefOid: 'a'.repeat(40) };

test('poll discovers no PR, records an open PR, emits no unchanged update, and tracks its merge', async () => {
  const store = ledger();
  const calls: unknown[] = [];
  const script = [[], [open], [open], [{ ...open, state: 'MERGED' }]];
  const run: RunCommand = async (program, args) => {
    calls.push([program, args]);
    return JSON.stringify(script.shift());
  };
  const poller = new PrPoller(store, run);
  expect(await poller.poll()).toEqual({ changes: [], failures: [] });
  const first = await poller.poll();
  expect(first.changes).toEqual([{ id: open.url, worktreeId: 'tree', ...open }]);
  expect(store.pullRequests('thread')).toEqual([{ id: open.url, worktreeId: 'tree', url: open.url }]);
  expect(await poller.poll()).toEqual({ changes: [], failures: [] });
  expect((await poller.poll()).changes).toEqual([{ id: open.url, worktreeId: 'tree', ...open, state: 'MERGED' }]);
  expect(store.observedPullRequests('thread')[0].state).toBe('MERGED');
  expect(calls).toEqual(Array.from({ length: 4 }, () => ['gh', [
    'pr', 'list', '--repo', 'example/web', '--head', 'feat/export', '--state', 'all', '--limit', '1000',
    '--json', 'number,url,state,headRefOid',
  ]]));
});

test('gh failure preserves the last known PR and retries successfully on the next poll', async () => {
  const store = ledger();
  const script = [JSON.stringify([open]), new Error('gh unavailable'), JSON.stringify([{ ...open, state: 'MERGED' }])];
  const poller = new PrPoller(store, async () => {
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next!;
  });
  await poller.poll();
  expect(await poller.poll()).toEqual({ changes: [], failures: [{ worktreeId: 'tree', reason: 'GitHub poll failed' }] });
  expect(store.observedPullRequests('thread')[0].state).toBe('OPEN');
  expect((await poller.poll()).changes[0].state).toBe('MERGED');
});

test.each([
  'invalid json', '{}',
  JSON.stringify([{ ...open, state: 'unexpected' }]),
  JSON.stringify([{ ...open, number: 0 }]),
  JSON.stringify([{ ...open, url: 'javascript:alert(1)' }]),
  JSON.stringify([{ ...open, headRefOid: '' }]),
  JSON.stringify([open, { ...open, number: 13, url: 'bad' }]),
  JSON.stringify(Array.from({ length: 1000 }, () => open)),
])('incomplete or malformed gh output cannot overwrite the last known state (%#)', async output => {
  const store = ledger();
  const script = [JSON.stringify([open]), output];
  const poller = new PrPoller(store, async () => script.shift()!);
  await poller.poll();
  expect((await poller.poll()).failures).toHaveLength(1);
  expect(store.observedPullRequests('thread')).toEqual([{ ...open, id: open.url, worktreeId: 'tree' }]);
});

test('the 60-second poller emits changes only, retries failures, stops, and never overlaps a slow poll', async () => {
  vi.useFakeTimers();
  const store = ledger();
  let finish: (output: string) => void = () => {};
  let calls = 0;
  const poller = new PrPoller(store, async () => {
    calls++;
    if (calls === 1) return new Promise<string>(resolve => { finish = resolve; });
    if (calls === 2) throw new Error('offline');
    return JSON.stringify([open]);
  });
  const changes: unknown[] = [];
  const failures: unknown[] = [];
  const stop = poller.start(change => { changes.push(change); }, failure => { failures.push(failure); });
  await vi.advanceTimersByTimeAsync(59_999);
  expect(calls).toBe(0);
  await vi.advanceTimersByTimeAsync(120_001);
  expect(calls).toBe(1);
  finish(JSON.stringify([open]));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(changes).toEqual([{ id: open.url, worktreeId: 'tree', ...open }]);
  expect(failures).toEqual([{ worktreeId: 'tree', reason: 'GitHub poll failed' }]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(calls).toBe(3);
  expect(changes).toHaveLength(1);
  stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(calls).toBe(3);
});

test('one failing repository does not prevent discovering another worktree PR', async () => {
  const store = ledger();
  store.saveWorktree({ id: 'api-tree', threadId: 'thread', repository: 'example/api', branch: 'feat/api' });
  const apiPr = { ...open, url: 'https://github.com/example/api/pull/12' };
  const poller = new PrPoller(store, async (_program, args) => {
    if (args.includes('example/web')) throw new Error('offline');
    return JSON.stringify([apiPr]);
  });
  expect(await poller.poll()).toEqual({ changes: [{ ...apiPr, id: apiPr.url, worktreeId: 'api-tree' }],
    failures: [{ worktreeId: 'tree', reason: 'GitHub poll failed' }] });
});
