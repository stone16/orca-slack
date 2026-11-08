import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Cleanup } from '../src/cleanup.js';
import type { RunCommand } from '../src/commands.js';
import { Store } from '../src/store.js';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
const head = 'a'.repeat(40);
const pr = { number: 12, url: 'https://github.com/example/web/pull/12', state: 'MERGED', headRefOid: head };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-cleanup-'));
  roots.push(root);
  const path = join(root, 'feature');
  mkdirSync(path);
  const file = join(root, 'ledger.sqlite');
  const store = new Store(file);
  stores.push(store);
  store.saveThread({ id: 'thread', channel: 'C1', threadTs: '1', owner: 'U1' });
  const tree = { id: `repo::${path}`, threadId: 'thread', repository: 'example/web', branch: 'feat/export' };
  store.saveWorktree(tree);
  const state = { prs: [pr], agents: [] as { liveness: string }[], status: '', stash: '', head,
    instanceId: 'instance-1', present: true, truncated: false, main: false, ghFailed: false };
  const calls: [string, string[]][] = [];
  const run: RunCommand = async (program, args) => {
    calls.push([program, args]);
    if (program === 'gh') {
      if (state.ghFailed) throw new Error('offline');
      return JSON.stringify(state.prs);
    }
    if (program === 'orca') {
      let result: unknown;
      if (args[1] === 'ps') result = { truncated: state.truncated, worktrees: state.present ? [{
        worktreeId: tree.id, worktreeInstanceId: state.instanceId, hostId: 'local', agents: state.agents,
        unverifiableTerminalCount: 0,
      }] : [] };
      else if (args[1] === 'show') result = { worktree: { id: tree.id, instanceId: state.instanceId,
        identity: { key: `wt2:local:${state.instanceId}` }, hostId: 'local', path, isMainWorktree: state.main } };
      else if (args[1] === 'rm') {
        state.present = false;
        rmSync(path, { recursive: true });
        result = { removed: true };
      } else throw new Error('Unexpected Orca command');
      return JSON.stringify({ ok: true, result });
    }
    const command = args[2];
    if (command === 'status') return state.status;
    if (command === 'stash') return state.stash;
    if (command === 'symbolic-ref') return 'refs/heads/feat/export\n';
    if (command === 'rev-parse' && args.includes('--show-toplevel')) return `${path}\n`;
    if (command === 'rev-parse') return `${state.head}\n`;
    throw new Error('Unexpected Git command');
  };
  return { store, root, path, file, tree, state, calls, run };
}

test.each([
  ['no PR', [], [], false],
  ['open PR', ['OPEN'], [], false],
  ['closed unmerged PR', ['CLOSED'], [], false],
  ['merged PR', ['MERGED'], [], true],
  ['merged and open PRs', ['MERGED', 'OPEN'], [], false],
  ['merged and closed PRs', ['MERGED', 'CLOSED'], [], false],
  ['two merged PRs', ['MERGED', 'MERGED'], [], true],
  ['running agent', ['MERGED'], ['live'], false],
  ['unknown agent', ['MERGED'], ['unverifiable'], false],
  ['ended agent', ['MERGED'], ['exited'], true],
] as const)('cleanup availability matrix: %s', async (_name, states, agents, allowed) => {
  const f = fixture();
  f.state.prs = states.map((state, i) => ({ ...pr, number: 12 + i,
    url: `https://github.com/example/web/pull/${12 + i}`, state }));
  f.state.agents = agents.map(liveness => ({ liveness }));
  expect((await new Cleanup(f.store, f.run).check(f.tree.id)).allowed).toBe(allowed);
  expect(f.calls.some(([program, args]) => program === 'orca' && args[1] === 'rm')).toBe(false);
});

test.each([
  ['uncommitted changes', { status: ' M tracked.txt\0' }, 'Uncommitted or untracked changes'],
  ['untracked files', { status: '?? new.txt\0' }, 'Uncommitted or untracked changes'],
  ['ignored files', { status: '!! local.env\0' }, 'Uncommitted or untracked changes'],
  ['stash', { stash: 'stash@{0}\n' }, 'Stash present'],
  ['post-merge commit', { head: 'b'.repeat(40) }, 'HEAD differs from merged pull request head commit'],
  ['main checkout', { main: true }, 'Cannot clean main worktree'],
  ['incomplete agent inventory', { truncated: true }, 'Agent state unknown'],
  ['GitHub unavailable', { ghFailed: true }, 'GitHub state unknown'],
] as const)('cleanup refuses and names %s', async (_name, changes, reason) => {
  const f = fixture();
  Object.assign(f.state, changes);
  expect(await new Cleanup(f.store, f.run).check(f.tree.id)).toMatchObject({ allowed: false, reasons: [reason] });
});

test('a squash merge passes when local HEAD equals the PR head, without comparing the base merge commit', async () => {
  const f = fixture();
  expect(await new Cleanup(f.store, f.run).check(f.tree.id)).toMatchObject({ allowed: true, finalCommit: head });
  expect(f.calls.filter(([program]) => program === 'git').map(([, args]) => args)).toEqual([
    ['-C', f.path, 'rev-parse', '--show-toplevel'],
    ['-C', f.path, 'symbolic-ref', '--quiet', 'HEAD'],
    ['-C', f.path, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'],
    ['-C', f.path, 'stash', 'list', '--format=%gd'],
    ['-C', f.path, 'rev-parse', '--verify', 'HEAD'],
  ]);
});

test('an active ledger session blocks cleanup even if Orca reports no agents', async () => {
  const f = fixture();
  f.store.replaceLead({ id: 'session', threadId: 'thread', worktreeId: f.tree.id,
    runId: 'run', taskId: 'task', dispatchId: 'dispatch', handle: 'handle' });
  expect(await new Cleanup(f.store, f.run).check(f.tree.id)).toEqual({ allowed: false, reasons: ['Running agent'] });
});

test('Git or Orca inspection failures retain the worktree and do not fabricate a safe result', async () => {
  const f = fixture();
  for (const fail of ['git', 'orca']) {
    const run: RunCommand = async (program, args) => {
      if (program === fail) throw new Error('inspection failed');
      return f.run(program, args);
    };
    expect((await new Cleanup(f.store, run).check(f.tree.id)).allowed).toBe(false);
  }
});

test('confirmed cleanup durably saves the receipt, PR link, final commit, and session report before deletion', async () => {
  const f = fixture();
  f.store.replaceLead({ id: 'session', threadId: 'thread', worktreeId: f.tree.id,
    runId: 'run', taskId: 'task', dispatchId: 'dispatch', handle: 'handle' });
  f.store.endLead('session');
  f.store.persistReports('run', [{ id: 'report', type: 'worker_done', body: 'Feature ready',
    payload: JSON.stringify({ taskId: 'task', dispatchId: 'dispatch', outcome: 'succeeded' }) }]);
  let durable = false;
  const run: RunCommand = async (program, args) => {
    if (program === 'orca' && args[1] === 'rm') {
      const reopened = new Store(f.file);
      try {
        expect(reopened.cleanupReceipts('thread')).toEqual([expect.objectContaining({ worktreeId: f.tree.id,
          state: 'saved', finalCommit: head, confirmedBy: 'U1', pullRequests: [expect.objectContaining({ url: pr.url })],
          sessions: [expect.objectContaining({ dispatchId: 'dispatch', active: false })],
          reports: [expect.objectContaining({ id: 'report', body: 'Feature ready' })] })]);
        durable = true;
      } finally { reopened.close(); }
      expect(args).toEqual(['worktree', 'rm', '--worktree', 'identity:wt2:local:instance-1', '--json']);
    }
    return f.run(program, args);
  };
  const cleanup = new Cleanup(f.store, run);
  expect(await cleanup.confirm(f.tree.id, 'U1')).toMatchObject({ status: 'deleted', receipt: { state: 'deleted' } });
  expect(durable).toBe(true);
  expect(f.store.pullRequests('thread')).toHaveLength(1);
  expect(f.store.trackedWorktrees()).toEqual([]);
  expect(await cleanup.confirm(f.tree.id, 'U1')).toMatchObject({ status: 'already-deleted' });
  expect(f.calls.filter(([program, args]) => program === 'orca' && args[1] === 'rm')).toHaveLength(1);
});

test('a crash after saving survives reopen and retries exactly one deletion', async () => {
  const f = fixture();
  const cleanup = new Cleanup(f.store, f.run, step => {
    if (step === 'after-save') throw new Error('simulated crash');
  });
  await expect(cleanup.confirm(f.tree.id, 'U1')).rejects.toThrow('simulated crash');
  expect(f.calls.some(([program, args]) => program === 'orca' && args[1] === 'rm')).toBe(false);
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  const reopened = new Store(f.file);
  stores.push(reopened);
  const saved = reopened.cleanupReceipt(f.tree.id);
  expect(saved).toMatchObject({ state: 'saved', finalCommit: head,
    pullRequests: [expect.objectContaining({ url: pr.url })] });
  const retry = new Cleanup(reopened, f.run);
  expect(await retry.confirm(f.tree.id, 'U1')).toMatchObject({ status: 'deleted', receipt: { id: saved!.id } });
  expect(await retry.confirm(f.tree.id, 'U1')).toMatchObject({ status: 'already-deleted' });
  expect(f.calls.filter(([program, args]) => program === 'orca' && args[1] === 'rm')).toHaveLength(1);
});

test('a crash after deletion reconciles absence on reopen without deleting twice', async () => {
  const f = fixture();
  const cleanup = new Cleanup(f.store, f.run, step => {
    if (step === 'after-delete') throw new Error('simulated crash');
  });
  await expect(cleanup.confirm(f.tree.id, 'U1')).rejects.toThrow('simulated crash');
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  const reopened = new Store(f.file);
  stores.push(reopened);
  expect(reopened.cleanupReceipt(f.tree.id)).toMatchObject({ state: 'saved', finalCommit: head });
  expect(await new Cleanup(reopened, f.run).confirm(f.tree.id, 'U1')).toMatchObject({ status: 'deleted',
    receipt: { state: 'deleted', pullRequests: [expect.objectContaining({ url: pr.url })], finalCommit: head } });
  expect(f.calls.filter(([program, args]) => program === 'orca' && args[1] === 'rm')).toHaveLength(1);
});

test('cleanup retries recheck safety and refuse a replacement worktree instance', async () => {
  const f = fixture();
  await expect(new Cleanup(f.store, f.run, () => { throw new Error('stop'); }).confirm(f.tree.id, 'U1')).rejects.toThrow('stop');
  f.state.status = '?? new.txt\0';
  expect(await new Cleanup(f.store, f.run).confirm(f.tree.id, 'U1')).toMatchObject({ status: 'refused',
    reasons: ['Uncommitted or untracked changes'] });
  f.state.status = '';
  f.state.instanceId = 'replacement';
  expect(await new Cleanup(f.store, f.run).confirm(f.tree.id, 'U1')).toMatchObject({ status: 'refused',
    reasons: ['Worktree changed since cleanup was confirmed'] });
  expect(f.calls.some(([program, args]) => program === 'orca' && args[1] === 'rm')).toBe(false);
});

test('a missing Orca entry with remaining files cannot be treated as deleted', async () => {
  const f = fixture();
  await expect(new Cleanup(f.store, f.run, () => { throw new Error('stop'); }).confirm(f.tree.id, 'U1')).rejects.toThrow('stop');
  f.state.present = false;
  expect(await new Cleanup(f.store, f.run).confirm(f.tree.id, 'U1')).toMatchObject({ status: 'refused' });
  expect(f.store.cleanupReceipt(f.tree.id)!.state).toBe('saved');
});

test('only an explicit confirmation from the owner can save a receipt and delete', async () => {
  const f = fixture();
  const cleanup = new Cleanup(f.store, f.run);
  expect(await cleanup.confirm(f.tree.id, 'U2')).toMatchObject({ status: 'refused' });
  expect(f.store.cleanupReceipts('thread')).toEqual([]);
  expect(f.calls).toEqual([]);
  f.state.status = ' M tracked.txt\0';
  expect(await cleanup.confirm(f.tree.id, 'U1')).toMatchObject({ status: 'refused' });
  expect(f.store.cleanupReceipts('thread')).toEqual([]);
});

test('simultaneous duplicate confirmations issue only one deletion', async () => {
  const f = fixture();
  const cleanup = new Cleanup(f.store, f.run);
  expect((await Promise.all([cleanup.confirm(f.tree.id, 'U1'), cleanup.confirm(f.tree.id, 'U1')]))
    .map(result => result.status)).toEqual(['deleted', 'already-deleted']);
  expect(f.calls.filter(([program, args]) => program === 'orca' && args[1] === 'rm')).toHaveLength(1);
});

test('an ambiguous deletion response keeps the durable receipt and a retry reconciles without a second delete', async () => {
  const f = fixture();
  const run: RunCommand = async (program, args) => {
    const output = await f.run(program, args);
    if (program === 'orca' && args[1] === 'rm') throw new Error('response lost');
    return output;
  };
  const cleanup = new Cleanup(f.store, run);
  expect(await cleanup.confirm(f.tree.id, 'U1')).toMatchObject({ status: 'refused' });
  expect(f.store.cleanupReceipt(f.tree.id)!.state).toBe('saved');
  expect(await cleanup.confirm(f.tree.id, 'U1')).toMatchObject({ status: 'deleted' });
  expect(f.calls.filter(([program, args]) => program === 'orca' && args[1] === 'rm')).toHaveLength(1);
});

test('a successful envelope without removal leaves the receipt pending', async () => {
  const f = fixture();
  const run: RunCommand = async (program, args) => program === 'orca' && args[1] === 'rm'
    ? JSON.stringify({ ok: true, result: {} }) : f.run(program, args);
  expect(await new Cleanup(f.store, run).confirm(f.tree.id, 'U1')).toMatchObject({ status: 'refused' });
  expect(f.store.cleanupReceipt(f.tree.id)!.state).toBe('saved');
});

test('cleanup rechecks agents after saving and refuses if a new agent starts before deletion', async () => {
  const f = fixture();
  const cleanup = new Cleanup(f.store, f.run, step => {
    if (step === 'after-save') f.state.agents = [{ liveness: 'live' }];
  });
  expect(await cleanup.confirm(f.tree.id, 'U1')).toMatchObject({ status: 'refused', reasons: ['Running agent'] });
  expect(f.store.cleanupReceipt(f.tree.id)!.state).toBe('saved');
  expect(f.calls.some(([program, args]) => program === 'orca' && args[1] === 'rm')).toBe(false);
});

test('cleanup accepts a ledger branch stored as a full Orca ref', async () => {
  const f = fixture();
  const second = { ...f.tree, id: 'second-tree', branch: 'refs/heads/feat/export' };
  f.store.saveThread({ id: 'second-thread', channel: 'C1', threadTs: '2', owner: 'U1' });
  f.store.saveWorktree({ ...second, threadId: 'second-thread' });
  const run: RunCommand = async (program, args) => {
    const output = await f.run(program, args);
    return program === 'orca' ? output.replaceAll(f.tree.id, second.id) : output;
  };
  expect((await new Cleanup(f.store, run).check(second.id)).allowed).toBe(true);
});

test.each(['OPEN', 'MERGED'])('another worktree must have merged PRs and ended agents (%s)', async state => {
  const f = fixture();
  f.store.saveWorktree({ id: 'api-tree', threadId: 'thread', repository: 'example/api', branch: 'feat/api' });
  const run: RunCommand = async (program, args) => {
    if (program === 'gh' && args.includes('example/api')) return JSON.stringify([
      { ...pr, url: 'https://github.com/example/api/pull/12', state },
    ]);
    const output = await f.run(program, args);
    if (program === 'orca' && args[1] === 'ps') {
      const envelope = JSON.parse(output);
      envelope.result.worktrees.push({ worktreeId: 'api-tree', worktreeInstanceId: 'api-instance', hostId: 'local',
        agents: [{ liveness: state === 'MERGED' ? 'live' : 'exited' }], unverifiableTerminalCount: 0 });
      return JSON.stringify(envelope);
    }
    return output;
  };
  expect((await new Cleanup(f.store, run).check(f.tree.id)).allowed).toBe(false);
});

test('a fresh gh failure cannot authorize cleanup from a previously merged cached state', async () => {
  const f = fixture();
  const cleanup = new Cleanup(f.store, f.run);
  expect((await cleanup.check(f.tree.id)).allowed).toBe(true);
  f.state.ghFailed = true;
  expect(await cleanup.check(f.tree.id)).toEqual({ allowed: false, reasons: ['GitHub state unknown'] });
  expect(f.store.observedPullRequests('thread')[0].state).toBe('MERGED');
});
