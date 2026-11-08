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

test('poll enriches an existing ledger PR without duplicating its link or changing its identity', async () => {
  const store = ledger();
  store.savePullRequest({ id: 'existing-pr', worktreeId: 'tree', url: open.url });
  const result = await new PrPoller(store, async () => JSON.stringify([open])).poll();
  expect(result.changes).toEqual([{ ...open, id: 'existing-pr', worktreeId: 'tree' }]);
  expect(store.pullRequests('thread')).toEqual([{ id: 'existing-pr', worktreeId: 'tree', url: open.url }]);
});

test('poll accepts the full branch ref reported by Orca and queries gh with its branch name', async () => {
  const store = ledger();
  store.saveWorktree({ id: 'api-tree', threadId: 'thread', repository: 'example/api', branch: 'refs/heads/feat/api' });
  const calls: string[][] = [];
  await new PrPoller(store, async (_program, args) => { calls.push(args); return '[]'; }).poll();
  expect(calls[1].slice(4, 6)).toEqual(['--head', 'feat/api']);
});

test.each([
  ['change', false], ['failure', false], ['change', true], ['failure', true],
])('a throwing %s callback is contained and the next poll still runs (async %s)', async (callback, asynchronous) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const store = ledger();
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', listener);
  let polls = 0;
  const poller = new PrPoller(store, async () => {
    polls++;
    if (callback === 'failure' && polls === 1) throw new Error('gh offline');
    return JSON.stringify([{ ...open, headRefOid: polls === 1 ? 'a'.repeat(40) : 'b'.repeat(40) }]);
  });
  let changes = 0;
  const failures: unknown[] = [];
  const fail = (message: string) => {
    if (asynchronous) return Promise.reject(new Error(message));
    throw new Error(message);
  };
  const stop = poller.start(() => {
    changes++;
    if (callback === 'change' && changes === 1) return fail('change callback failed');
  }, failure => {
    failures.push(failure);
    if (callback === 'failure') return fail('failure callback failed');
  });
  try {
    await vi.advanceTimersByTimeAsync(120_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).toEqual([]);
    expect(polls).toBe(2);
    expect(changes).toBe(callback === 'change' ? 2 : 1);
    expect(failures).toEqual([{ worktreeId: 'tree', reason: callback === 'change'
      ? 'PR change callback failed' : 'GitHub poll failed' }]);
  } finally {
    stop();
    process.off('unhandledRejection', listener);
  }
});
