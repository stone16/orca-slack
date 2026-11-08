import { expect, test } from 'vitest';
import { LeadCli } from '../src/lead-orca.js';

test('normalizes the measured worktree envelope and strips the Git branch prefix', async () => {
  const commands: string[][] = [];
  const orca = new LeadCli(async args => {
    commands.push(args);
    return { stdout: '{"ok":true,"result":{"worktree":{"id":"repo::tree","branch":"refs/heads/feature"}}}' };
  });
  expect(await orca.createWorktree('repo', 'feature')).toEqual({ id: 'repo::tree', branch: 'feature' });
  expect(commands).toEqual([['worktree', 'create', '--repo', 'id:repo', '--name', 'feature', '--no-parent', '--setup', 'skip', '--json']]);
});

test('terminal paging preserves its source and cursor and recognizes an exited terminal', async () => {
  const commands: string[][] = [];
  const orca = new LeadCli(async args => {
    commands.push(args);
    return { stdout: '{"ok":true,"result":{"terminal":{"status":"exited","source":"stream","nextCursor":"7"}}}' };
  });
  expect(await orca.readTerminal('handle', '6')).toEqual({ status: 'exited', source: 'stream', nextCursor: '7' });
  expect(commands).toEqual([['terminal', 'read', '--terminal', 'handle', '--cursor', '6', '--json']]);
});

test.each([{}, { worktree: { id: 'tree' } }, { worktree: { id: '', branch: 'feature' } }])('rejects a malformed worktree receipt %j', async result => {
  const orca = new LeadCli(async () => ({ stdout: JSON.stringify({ ok: true, result }) }));
  await expect(orca.createWorktree('repo', 'feature')).rejects.toThrow('Invalid worktree receipt');
});
