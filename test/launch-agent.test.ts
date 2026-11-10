import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { install, uninstall, renderLaunchAgent } from '../scripts/launch-agent.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
test('LaunchAgent installation renders paths, loads the service, and uninstalls without removing data', () => {
  const root = mkdtempSync(join(tmpdir(), 'launch-agent-'));
  roots.push(root);
  const checkout = join(root, 'checkout & space'), agentDirectory = join(root, 'agents'), logDirectory = join(root, 'logs');
  mkdirSync(join(checkout, 'dist'), { recursive: true }); mkdirSync(join(checkout, 'deploy'));
  writeFileSync(join(checkout, 'dist', 'main.js'), ''); writeFileSync(join(checkout, 'config.local.json'), '{}'); writeFileSync(join(checkout, '.env'), '');
  const template = readFileSync(new URL('../deploy/launch-agent.plist.template', import.meta.url), 'utf8');
  writeFileSync(join(checkout, 'deploy', 'launch-agent.plist.template'), template);
  let loaded = false;
  const commands: string[][] = [];
  const run = (args: string[]) => {
    commands.push(args);
    if (args[0] === 'print' && !loaded) throw Object.assign(new Error('not loaded'), { status: 113 });
    if (args[0] === 'bootstrap') loaded = true;
    if (args[0] === 'bootout') loaded = false;
    return '';
  };
  const options = { label: 'dev.example.bridge', checkout, agentDirectory, logDirectory, path: 'bin-placeholder' };
  const plist = install(options, run);
  expect(loaded).toBe(true);
  const rendered = readFileSync(plist, 'utf8');
  expect(rendered).toContain('checkout &amp; space'); expect(rendered).toContain(logDirectory);
  expect(rendered).not.toContain('{{'); expect(rendered).not.toContain('SLACK_BOT_TOKEN');
  expect(rendered).toContain('<key>KeepAlive</key><true/>');
  install(options, run);
  expect(commands.filter(args => args[0] === 'bootstrap')).toHaveLength(2);
  expect(commands.filter(args => args[0] === 'bootout')).toHaveLength(1);
  uninstall(options, run);
  expect(loaded).toBe(false);
  expect(() => readFileSync(plist)).toThrow();
  expect(readFileSync(join(checkout, 'config.local.json'), 'utf8')).toBe('{}');
});
test('committed LaunchAgent template has placeholders for every machine path and XML escaping rejects missing values', () => {
  const template = readFileSync(new URL('../deploy/launch-agent.plist.template', import.meta.url), 'utf8');
  expect(template).not.toMatch(/<string>\s*\//);
  expect(() => renderLaunchAgent(template, {})).toThrow('template');
  expect(() => install({ label: '../invalid' }, () => '')).toThrow('label');
});


test('LaunchAgent uninstall preserves its plist when launchctl cannot establish service state', () => {
  const root = mkdtempSync(join(tmpdir(), 'launch-agent-state-'));
  roots.push(root);
  const file = join(root, 'dev.example.bridge.plist'); writeFileSync(file, 'preserved');
  expect(() => uninstall({ label: 'dev.example.bridge', agentDirectory: root }, () => { throw new Error('permission denied'); })).toThrow('permission denied');
  expect(readFileSync(file, 'utf8')).toBe('preserved');
});
