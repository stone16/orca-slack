import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';

let root: string;
let mounted = false;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'archive-volume-'));
  const image = join(root, 'archive.dmg');
  mkdirSync(join(root, 'mounted'));
  execFileSync('hdiutil', ['create', '-size', '32m', '-fs', 'HFS+', '-volname', 'ArchiveTest', image],
    { stdio: 'pipe', timeout: 30_000 });
  execFileSync('hdiutil', ['attach', '-nobrowse', '-mountpoint', join(root, 'mounted'), image],
    { stdio: 'pipe', timeout: 30_000 });
  mounted = true;
}, 60_000);
afterAll(() => {
  if (mounted) execFileSync('hdiutil', ['detach', join(root, 'mounted')], { stdio: 'pipe', timeout: 30_000 });
  if (root) rmSync(root, { recursive: true, force: true });
}, 40_000);

export function makeArchive(path: string): void {
  const directory = join(root, 'mounted', randomUUID());
  mkdirSync(directory);
  writeFileSync(join(directory, '.orca-slack-archive'), '');
  symlinkSync(directory, path);
}

export function archiveFiles(directory: string): string[] {
  return readdirSync(directory).filter(name => name !== '.orca-slack-archive');
}
