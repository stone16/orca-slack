import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const bin = join(root, 'bin');
  for (const name of ['node', 'orca', 'gh', 'git']) executable(bin, name);
  const options = { label: 'dev.example.bridge', checkout, agentDirectory, logDirectory, searchPath: bin };
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


function deployment() {
  const root = mkdtempSync(join(tmpdir(), 'launch-agent-tools-')); roots.push(root);
  const checkout = join(root, 'checkout'), agentDirectory = join(root, 'agents');
  mkdirSync(join(checkout, 'dist'), { recursive: true }); mkdirSync(join(checkout, 'deploy'));
  writeFileSync(join(checkout, 'dist', 'main.js'), ''); writeFileSync(join(checkout, 'config.local.json'), '{}'); writeFileSync(join(checkout, '.env'), '');
  writeFileSync(join(checkout, 'deploy', 'launch-agent.plist.template'), readFileSync(new URL('../deploy/launch-agent.plist.template', import.meta.url)));
  const commands: string[][] = [];
  const run = (args: string[]) => { commands.push(args); if (args[0] === 'print') throw Object.assign(new Error('absent'), { status: 113 }); return ''; };
  return { root, checkout, agentDirectory, commands, run };
}
function executable(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true }); const file = join(directory, name);
  writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); return file;
}

test('LaunchAgent uses a stable Node link even when a Cellar binary appears first on PATH', () => {
  const f = deployment(); const cellar = join(f.root, 'Cellar', 'node', '1', 'bin'), stable = join(f.root, 'managed', 'bin');
  const target = executable(cellar, 'node'); mkdirSync(stable, { recursive: true }); symlinkSync(target, join(stable, 'node'));
  for (const name of ['orca', 'gh', 'git']) executable(stable, name);
  const options = { ...f, label: 'dev.example.bridge', searchPath: [cellar, stable].join(':') };
  const plist = install(options, f.run);
  expect(readFileSync(plist, 'utf8')).toContain(`<string>${join(stable, 'node')}</string>`);
  expect(readFileSync(plist, 'utf8')).not.toContain(cellar);
});

test('LaunchAgent refuses installation when only a versioned Node path is available', () => {
  const f = deployment(); const cellar = join(f.root, 'Cellar', 'node', '1', 'bin'), tools = join(f.root, 'tools');
  executable(cellar, 'node'); for (const name of ['orca', 'gh', 'git']) executable(tools, name);
  const options = { ...f, label: 'dev.example.bridge', searchPath: [cellar, tools].join(':') };
  expect(() => install(options, f.run)).toThrow(/stable node/i);
  expect(f.commands).toEqual([]);
});

test('LaunchAgent renders only resolved tool directories and system directories in PATH', () => {
  const f = deployment(); const shared = join(f.root, 'shared-bin'), gh = join(f.root, 'gh-bin'), git = join(f.root, 'git-bin'), transient = join(f.root, 'agent-session');
  executable(shared, 'node'); executable(shared, 'orca'); executable(gh, 'gh'); executable(git, 'git'); mkdirSync(transient);
  const options = { ...f, label: 'dev.example.bridge', searchPath: [transient, shared, gh, git, '/usr/bin', '/bin'].join(':') };
  const plist = install(options, f.run), rendered = readFileSync(plist, 'utf8');
  const expected = [shared, gh, git, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  expect(rendered).toContain(`<key>PATH</key><string>${expected}</string>`);
  expect(rendered).not.toContain(transient);
});
