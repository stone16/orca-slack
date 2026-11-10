import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

const hook = `#!/bin/sh
set -eu
deny() { echo "Push guard: $1" >&2; exit 1; }
remote_head=$(git ls-remote --symref -- "$2" HEAD) || deny 'Cannot verify the remote default branch'
default_ref=$(printf '%s\\n' "$remote_head" | awk '$1 == "ref:" && $3 == "HEAD" { print $2 }')
case "$default_ref" in refs/heads/*) ;; *) deny 'Cannot verify the remote default branch' ;; esac
git check-ref-format "$default_ref" || deny 'Invalid remote default branch'
while read -r local_ref local_oid remote_ref remote_oid extra; do
  [ -n "$local_ref" ] && [ -n "$local_oid" ] && [ -n "$remote_ref" ] && [ -n "$remote_oid" ] && [ -z "$extra" ] || deny 'Invalid push update'
  [ "$remote_ref" != "$default_ref" ] || deny 'Default branch updates are blocked'
  case "$remote_ref" in refs/heads/*|refs/tags/*) ;; *) deny 'Unsupported ref namespace' ;; esac
  case "$remote_oid" in *[!0]*)
    case "$remote_ref" in refs/heads/*) ;; *) deny 'Existing non-branch ref updates are blocked' ;; esac
    git --no-replace-objects merge-base --is-ancestor "$remote_oid" "$local_oid" || deny 'Non-fast-forward or unverifiable updates are blocked'
  ;; esac
done
`;

export function installPushGuard(repository: string, hooksDirectory: string): string {
  const git = (checkout: string, ...args: string[]) => execFileSync('git', ['-C', checkout, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const canonical = (path: string): string => {
    try { return realpathSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return join(canonical(dirname(path)), basename(path));
    }
  };
  const directory = resolve(hooksDirectory);
  const physicalDirectory = canonical(directory);
  const worktrees = git(repository, 'worktree', 'list', '--porcelain', '-z').split('\0\0').filter(Boolean);
  for (const record of worktrees) {
    const fields = record.split('\0');
    const worktree = fields[0].slice('worktree '.length);
    if (fields.some(field => field === 'prunable' || field.startsWith('prunable '))) continue;
    try { statSync(worktree); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const physicalWorktree = canonical(worktree);
    if (physicalDirectory === physicalWorktree || physicalDirectory.startsWith(`${physicalWorktree}${sep}`)) {
      throw new Error('Hooks must be outside every worktree');
    }
    let configured: string | undefined;
    try { configured = git(worktree, 'config', '--get', 'core.hooksPath'); }
    catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
    if (configured !== undefined && configured !== directory) throw new Error('Existing hooks path must be preserved');
    if (configured === undefined) {
      const existing = join(git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'hooks');
      if (existsSync(existing) && readdirSync(existing).some(file => !file.endsWith('.sample'))) {
        throw new Error('Existing hooks must be preserved');
      }
    }
  }
  const destination = join(directory, 'pre-push');
  if (existsSync(destination) && readFileSync(destination, 'utf8') !== hook) {
    throw new Error('Existing pre-push hook must be preserved');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existsSync(destination)) writeFileSync(destination, hook, { flag: 'wx', mode: 0o700 });
  chmodSync(destination, 0o700);
  git(repository, 'config', '--local', 'core.hooksPath', directory);
  return destination;
}
