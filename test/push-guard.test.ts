import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { installPushGuard } from '../src/push-guard.js';

const roots: string[] = [];
beforeEach(() => {
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
  return { status: result.status, output: `${result.stdout}${result.stderr}`.trim() };
}
function run(cwd: string, ...args: string[]) {
  const result = git(cwd, ...args);
  expect(result.status, result.output).toBe(0);
  return result.output;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-guard-'));
  roots.push(root);
  const repository = join(root, 'checkout');
  const remote = join(root, 'remote.git');
  const worktree = join(root, 'linked');
  const hooksDirectory = join(root, 'hooks');
  run(root, 'init', '--bare', '--initial-branch=trunk', remote);
  run(root, 'init', '--initial-branch=trunk', repository);
  run(repository, 'config', 'user.name', 'Test');
  run(repository, 'config', 'user.email', 'test@example.invalid');
  run(repository, 'commit', '--allow-empty', '-m', 'test: seed');
  run(repository, 'remote', 'add', 'origin', remote);
  run(repository, 'push', 'origin', 'trunk');
  run(repository, 'switch', '-c', 'feature-one');
  run(repository, 'worktree', 'add', '-b', 'feature-two', worktree);
  return { root, repository, remote, worktree, hooksDirectory };
}
function evidence(root: string, name: string, result: ReturnType<typeof git>) {
  if (process.env.PUSH_GUARD_EVIDENCE) console.log(`${name}\nexit ${result.status}\n${result.output.replaceAll(root, '<tmp>')}`);
}

test('a guard outside every worktree allows normal feature pushes from both worktrees', () => {
  const { root, repository, worktree, hooksDirectory } = fixture();
  const hook = installPushGuard(repository, hooksDirectory);
  expect(hook).toBe(join(hooksDirectory, 'pre-push'));
  expect(existsSync(hook)).toBe(true);
  for (const checkout of [repository, worktree]) {
    expect(run(checkout, 'config', '--get', 'core.hooksPath')).toBe(hooksDirectory);
    run(checkout, 'commit', '--allow-empty', '-m', 'test: feature');
    const result = git(checkout, 'push', 'origin', 'HEAD');
    evidence(root, `git push origin HEAD from ${checkout === repository ? 'primary' : 'linked'} worktree`, result);
    expect(result.status, result.output).toBe(0);
  }
});

test.each(['primary', 'linked'])('the guard blocks default-branch updates and deletions from the %s worktree', source => {
  const { root, repository, remote, worktree, hooksDirectory } = fixture();
  installPushGuard(repository, hooksDirectory);
  const checkout = source === 'primary' ? repository : worktree;
  const before = run(remote, 'rev-parse', 'refs/heads/trunk');
  run(checkout, 'commit', '--allow-empty', '-m', 'test: default update');
  for (const ref of ['HEAD:refs/heads/trunk', ':refs/heads/trunk']) {
    const result = git(checkout, 'push', 'origin', ref);
    evidence(root, `git push origin ${ref} from ${source} worktree`, result);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain('Default branch updates are blocked');
    expect(run(remote, 'rev-parse', 'refs/heads/trunk')).toBe(before);
  }
});

test.each([
  ['primary', '--force'], ['linked', '--force'],
  ['primary', '--force-with-lease'], ['linked', '--force-with-lease'],
])('the guard blocks a %s worktree history rewrite with %s', (source, flag) => {
  const { root, repository, remote, worktree, hooksDirectory } = fixture();
  installPushGuard(repository, hooksDirectory);
  const checkout = source === 'primary' ? repository : worktree;
  const branch = run(checkout, 'branch', '--show-current');
  run(checkout, 'commit', '--allow-empty', '-m', 'test: original feature');
  run(checkout, 'push', 'origin', 'HEAD');
  const before = run(remote, 'rev-parse', `refs/heads/${branch}`);
  const replacement = run(checkout, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD~1', '-m', 'test: replacement');
  const ref = `${replacement}:refs/heads/${branch}`;
  const result = git(checkout, 'push', flag, 'origin', ref);
  evidence(root, `git push ${flag} origin <replacement>:refs/heads/${branch} from ${source} worktree`, result);
  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toContain('Non-fast-forward or unverifiable updates are blocked');
  expect(run(remote, 'rev-parse', `refs/heads/${branch}`)).toBe(before);
});

test.each(['primary', 'linked'])('installation refuses hooks inside the %s worktree', source => {
  const { repository, worktree } = fixture();
  const directory = join(source === 'primary' ? repository : worktree, 'hooks');
  expect(() => installPushGuard(repository, directory)).toThrow('outside every worktree');
  expect(existsSync(directory)).toBe(false);
  expect(git(repository, 'config', '--local', '--get', 'core.hooksPath').status).toBe(1);
});

test('installation is idempotent and refuses to overwrite a different pre-push hook', () => {
  const { repository, hooksDirectory } = fixture();
  const destination = installPushGuard(repository, hooksDirectory);
  const original = readFileSync(destination, 'utf8');
  expect(installPushGuard(repository, hooksDirectory)).toBe(destination);
  expect(readFileSync(destination, 'utf8')).toBe(original);
  writeFileSync(destination, '#!/bin/sh\nexit 42\n');
  expect(() => installPushGuard(repository, hooksDirectory)).toThrow('Existing pre-push hook');
  expect(readFileSync(destination, 'utf8')).toBe('#!/bin/sh\nexit 42\n');
});

test('installation preserves an existing default hooks directory instead of disabling validation', () => {
  const { repository, hooksDirectory } = fixture();
  const existing = join(repository, '.git', 'hooks', 'pre-commit');
  writeFileSync(existing, '#!/bin/sh\nexit 42\n', { mode: 0o700 });
  expect(() => installPushGuard(repository, hooksDirectory)).toThrow('Existing hooks');
  expect(readFileSync(existing, 'utf8')).toBe('#!/bin/sh\nexit 42\n');
  expect(git(repository, 'config', '--local', '--get', 'core.hooksPath').status).toBe(1);
});

test('installation refuses a conflicting shared hooks path', () => {
  const { root, repository, hooksDirectory } = fixture();
  const existing = join(root, 'existing-hooks');
  run(repository, 'config', '--local', 'core.hooksPath', existing);
  expect(() => installPushGuard(repository, hooksDirectory)).toThrow('Existing hooks path');
  expect(run(repository, 'config', '--local', '--get', 'core.hooksPath')).toBe(existing);
  expect(existsSync(hooksDirectory)).toBe(false);
});

test('installation refuses a linked worktree hooks override', () => {
  const { root, repository, worktree, hooksDirectory } = fixture();
  const existing = join(root, 'existing-hooks');
  run(repository, 'config', '--local', 'extensions.worktreeConfig', 'true');
  run(worktree, 'config', '--worktree', 'core.hooksPath', existing);
  expect(() => installPushGuard(repository, hooksDirectory)).toThrow('Existing hooks path');
  expect(run(worktree, 'config', '--worktree', '--get', 'core.hooksPath')).toBe(existing);
  expect(existsSync(hooksDirectory)).toBe(false);
});

test('an unverifiable remote default branch blocks a push instead of guessing', () => {
  const { repository, remote, hooksDirectory } = fixture();
  installPushGuard(repository, hooksDirectory);
  run(remote, 'symbolic-ref', 'HEAD', 'refs/heads/missing');
  const result = git(repository, 'push', 'origin', 'HEAD');
  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toContain('Cannot verify the remote default branch');
});

test('force flags that create or fast-forward a feature branch are allowed', () => {
  const { repository, hooksDirectory } = fixture();
  installPushGuard(repository, hooksDirectory);
  run(repository, 'push', '--force', 'origin', 'HEAD');
  run(repository, 'commit', '--allow-empty', '-m', 'test: fast forward');
  run(repository, 'push', '--force-with-lease', 'origin', 'HEAD');
});

test('installation from a linked worktree also protects worktrees created later', () => {
  const { root, repository, worktree, hooksDirectory } = fixture();
  installPushGuard(worktree, hooksDirectory);
  const later = join(root, 'later');
  run(repository, 'worktree', 'add', '-b', 'feature-later', later);
  expect(run(later, 'config', '--get', 'core.hooksPath')).toBe(hooksDirectory);
  run(later, 'commit', '--allow-empty', '-m', 'test: later feature');
  run(later, 'push', 'origin', 'HEAD');
  const result = git(later, 'push', 'origin', 'HEAD:refs/heads/trunk');
  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toContain('Default branch updates are blocked');
});

test('S6 a multi-ref push cannot publish a valid feature together with a default-branch update', () => {
  const { root, repository, remote, hooksDirectory } = fixture();
  installPushGuard(repository, hooksDirectory);
  run(repository, 'commit', '--allow-empty', '-m', 'test: multiple refs');
  const before = run(remote, 'rev-parse', 'trunk');
  const result = git(repository, 'push', 'origin', 'HEAD:refs/heads/feature-one', 'HEAD:refs/heads/trunk');
  evidence(root, 'multi-ref push', result);
  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toContain('Default branch updates are blocked');
  expect(run(remote, 'rev-parse', 'trunk')).toBe(before);
  expect(git(remote, 'show-ref', '--verify', 'refs/heads/feature-one').status).not.toBe(0);
});

test('S6 unknown remote ancestry blocks a rewrite without a local remote object', () => {
  const { root, repository, remote, hooksDirectory } = fixture();
  const other = join(root, 'other');
  run(root, 'clone', '--no-local', remote, other);
  run(other, 'config', 'user.name', 'Test');
  run(other, 'config', 'user.email', 'test@example.invalid');
  run(other, 'switch', '-c', 'feature-one');
  run(other, 'commit', '--allow-empty', '-m', 'test: remote-only commit');
  run(other, 'push', 'origin', 'HEAD');
  const before = run(remote, 'rev-parse', 'feature-one');
  expect(git(repository, 'cat-file', '-e', before).status).not.toBe(0);
  installPushGuard(repository, hooksDirectory);
  const result = git(repository, 'push', '--force', 'origin', 'HEAD:refs/heads/feature-one');
  evidence(root, 'unknown ancestry rewrite', result);
  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toContain('Non-fast-forward or unverifiable updates are blocked');
  expect(run(remote, 'rev-parse', 'feature-one')).toBe(before);
});

test('S6 feature deletion and replacement or deletion of existing tags are blocked', () => {
  const { root, repository, remote, hooksDirectory } = fixture();
  installPushGuard(repository, hooksDirectory);
  run(repository, 'push', 'origin', 'HEAD');
  run(repository, 'tag', 'v1');
  run(repository, 'push', 'origin', 'refs/tags/v1');
  const before = run(remote, 'rev-parse', 'refs/tags/v1');
  run(repository, 'commit', '--allow-empty', '-m', 'test: tag update');
  for (const ref of [':refs/heads/feature-one', 'HEAD:refs/tags/v1', ':refs/tags/v1']) {
    const result = git(repository, 'push', '--force', 'origin', ref);
    evidence(root, `protected ref ${ref}`, result);
    expect(result.status, result.output).not.toBe(0);
  }
  expect(run(remote, 'rev-parse', 'refs/tags/v1')).toBe(before);
  expect(run(remote, 'rev-parse', 'refs/heads/feature-one')).toBe(before);
});

test.each(['refs/replace/0123456789012345678901234567890123456789', 'refs/notes/custom'])(
  'S6 arbitrary new ref %s is blocked', ref => {
    const { root, repository, remote, hooksDirectory } = fixture();
    installPushGuard(repository, hooksDirectory);
    const result = git(repository, 'push', 'origin', `HEAD:${ref}`);
    evidence(root, `arbitrary new ref ${ref}`, result);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain('Unsupported ref namespace');
    expect(git(remote, 'show-ref', '--verify', ref).status).not.toBe(0);
  });

test.each(['prunable', 'missing', 'prunable directory'])('installation skips a %s worktree and still rejects a direct push to main', stale => {
  const { root, repository, remote, worktree, hooksDirectory } = fixture();
  run(repository, 'push', 'origin', 'HEAD:refs/heads/main');
  run(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  if (stale === 'missing') run(repository, 'worktree', 'lock', worktree);
  if (stale === 'prunable directory') rmSync(join(worktree, '.git'));
  else rmSync(worktree, { recursive: true });
  const listing = run(repository, 'worktree', 'list', '--porcelain');
  expect(listing).toContain(worktree);
  expect(listing.includes('prunable')).toBe(stale !== 'missing');
  expect(() => installPushGuard(repository, hooksDirectory)).not.toThrow();
  expect(run(repository, 'config', '--get', 'core.hooksPath')).toBe(hooksDirectory);
  run(repository, 'commit', '--allow-empty', '-m', 'test: guarded main update');
  const result = git(repository, 'push', 'origin', 'HEAD:refs/heads/main');
  evidence(root, `stale ${stale} worktree, git push origin HEAD:refs/heads/main`, result);
  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toContain('Default branch updates are blocked');
});

test('installation still fails on other git errors in an existing worktree', () => {
  const { repository, worktree, hooksDirectory } = fixture();
  run(repository, 'config', '--local', 'extensions.worktreeConfig', 'true');
  const gitDirectory = run(worktree, 'rev-parse', '--absolute-git-dir');
  writeFileSync(join(gitDirectory, 'config.worktree'), '[broken');
  expect(() => installPushGuard(repository, hooksDirectory)).toThrow();
  expect(existsSync(hooksDirectory)).toBe(false);
  expect(git(repository, 'config', '--get', 'core.hooksPath').status).toBe(1);
});
