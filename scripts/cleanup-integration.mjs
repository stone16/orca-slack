import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cleanup } from '../dist/cleanup.js';
import { runCommand } from '../dist/commands.js';
import { Store } from '../dist/store.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-cleanup-drive-')));
const results = [];
async function drive(name, change, expected, confirm = false) {
  const directory = join(root, name);
  const main = join(directory, 'main');
  const path = join(directory, 'feature');
  mkdirSync(directory);
  const git = (cwd, ...args) => runCommand('git', ['-C', cwd, ...args]);
  await runCommand('git', ['init', '-b', 'main', main]);
  await git(main, 'config', 'user.name', 'Integration Test');
  await git(main, 'config', 'user.email', 'integration@example.invalid');
  await git(main, 'config', 'commit.gpgSign', 'false');
  await git(main, 'config', 'core.hooksPath', join(directory, 'empty-hooks'));
  writeFileSync(join(main, 'README.md'), 'Disposable cleanup safety repository.\n');
  writeFileSync(join(main, '.gitignore'), 'local.env\n');
  await git(main, 'add', '.');
  await git(main, 'commit', '-m', 'test: seed disposable cleanup repository');
  await git(main, 'worktree', 'add', '-b', 'feat/export', path);
  writeFileSync(join(path, 'feature.txt'), 'First feature commit.\n');
  await git(path, 'add', 'feature.txt');
  await git(path, 'commit', '-m', 'feat: add disposable feature');
  writeFileSync(join(path, 'second.txt'), 'Second feature commit.\n');
  await git(path, 'add', 'second.txt');
  await git(path, 'commit', '-m', 'feat: extend disposable feature');
  const head = (await git(path, 'rev-parse', 'HEAD')).trim();
  await git(main, 'merge', '--squash', 'feat/export');
  await git(main, 'commit', '-m', 'feat: squash disposable feature');
  const mainHead = (await git(main, 'rev-parse', 'HEAD')).trim();
  assert.notEqual(mainHead, head, 'squash commit differs from PR head');
  const file = join(directory, 'ledger.sqlite');
  const store = new Store(file);
  const tree = { id: `disposable::${path}`, threadId: 'thread', repository: 'example/web', branch: 'feat/export' };
  store.saveThread({ id: 'thread', channel: 'C1', threadTs: '1', owner: 'U1' });
  store.saveWorktree(tree);
  const pr = { number: 12, url: 'https://github.com/example/web/pull/12', state: 'MERGED', headRefOid: head };
  const state = { agents: [], present: true, gitCommands: 0, deletionCommands: 0 };
  const run = async (program, args) => {
    if (program === 'git') {
      assert.equal(args[0], '-C');
      assert.equal(args[1], path, 'product Git inspection is scoped to the disposable worktree');
      state.gitCommands++;
      return runCommand(program, args);
    }
    if (program === 'gh') return JSON.stringify([pr]);
    assert.equal(program, 'orca');
    let result;
    if (args[1] === 'ps') result = { truncated: false, worktrees: state.present ? [{
      worktreeId: tree.id, worktreeInstanceId: 'instance-1', hostId: 'local',
      agents: state.agents, unverifiableTerminalCount: 0,
    }] : [] };
    else if (args[1] === 'show') result = { worktree: { id: tree.id, instanceId: 'instance-1',
      identity: { key: 'wt2:local:instance-1' }, hostId: 'local', path, isMainWorktree: false } };
    else if (args[1] === 'rm') {
      assert.deepEqual(args, ['worktree', 'rm', '--worktree', 'identity:wt2:local:instance-1', '--json']);
      const reopened = new Store(file);
      try {
        assert.equal(reopened.cleanupReceipt(tree.id).state, 'saved');
        assert.equal(reopened.cleanupReceipt(tree.id).finalCommit, head);
        assert.equal(reopened.cleanupReceipt(tree.id).pullRequests[0].url, pr.url);
      } finally { reopened.close(); }
      await git(main, 'worktree', 'remove', path);
      state.present = false;
      state.deletionCommands++;
      result = { removed: true };
    } else throw new Error('Unexpected scripted Orca command');
    return JSON.stringify({ ok: true, result });
  };
  try {
    await change({ path, main, git, state });
    const cleanup = new Cleanup(store, run);
    const checked = await cleanup.check(tree.id);
    assert.equal(checked.allowed, expected === null, name);
    if (expected) assert.ok(checked.reasons.includes(expected), name);
    if (confirm) {
      assert.equal((await cleanup.confirm(tree.id, 'U1')).status, 'deleted');
      assert.equal((await cleanup.confirm(tree.id, 'U1')).status, 'already-deleted');
      assert.equal(state.deletionCommands, 1);
      assert.equal(existsSync(path), false);
    }
    assert.equal((await git(main, 'rev-parse', 'HEAD')).trim(), mainHead, 'main HEAD unchanged');
    assert.equal(await git(main, 'status', '--porcelain=v1'), '', 'main checkout clean');
    const row = { case: name, allowed: checked.allowed, reasons: checked.reasons,
      realGitInspections: state.gitCommands, verdict: 'verified', ...(confirm ? {
        finalCommit: head, squashCommit: mainHead, receiptSavedBeforeDeletion: true, deletionCommands: 1,
      } : {}) };
    results.push(row);
    console.log(JSON.stringify(row));
  } finally { store.close(); }
}
let passed = false;
try {
  await drive('uncommitted', async ({ path }) => {
    writeFileSync(join(path, 'feature.txt'), 'Uncommitted work.\n');
  }, 'Uncommitted or untracked changes');
  await drive('untracked', async ({ path }) => {
    writeFileSync(join(path, 'scratch.txt'), 'Untracked work.\n');
  }, 'Uncommitted or untracked changes');
  await drive('ignored', async ({ path }) => {
    writeFileSync(join(path, 'local.env'), 'Disposable ignored content.\n');
  }, 'Uncommitted or untracked changes');
  await drive('stash', async ({ path, git }) => {
    writeFileSync(join(path, 'feature.txt'), 'Stashed work.\n');
    await git(path, 'stash', 'push', '-m', 'Disposable cleanup safety stash');
  }, 'Stash present');
  await drive('running-agent', async ({ state }) => {
    state.agents = [{ liveness: 'live' }];
  }, 'Running agent');
  await drive('head-mismatch', async ({ path, git }) => {
    await git(path, 'commit', '--allow-empty', '-m', 'test: add post-merge work');
  }, 'HEAD differs from merged pull request head commit');
  await drive('squash-merge', async () => {}, null, true);
  passed = true;
} catch (error) {
  console.error(String(error.message).replaceAll(root, '<temporary>'));
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true });
  console.log(JSON.stringify({ verdict: passed ? 'verified' : 'not verified', cases: results.length,
    boundaries: { git: 'real', github: 'scripted', orca: 'scripted' }, temporaryFilesRemoved: !existsSync(root) }));
}
