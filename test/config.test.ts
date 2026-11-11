import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadConfig, parseConfig, redactingLog } from '../src/config.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
export const settings = {
  botId: 'U00000001', ownerId: 'U00000002', allowedUsers: ['U00000002'],
  runId: 'run_fixture', coordinatorTerminal: 'term_fixture', agent: 'codex',
  archiveDirectory: '../archive', hooksDirectory: '../hooks',
  repositories: [{ id: 'repo-fixture', name: 'example', aliases: ['sample'], path: '../example', github: 'example/project' }],
};
export const secrets = { SLACK_BOT_TOKEN: 'xoxb-fixture-secret', SLACK_APP_TOKEN: 'xapp-fixture-secret' };

test('the coordinator terminal is an optional initial value', () => {
  const { coordinatorTerminal, ...value } = settings;
  expect(parseConfig(value, secrets, process.cwd()).coordinatorTerminal).toBeUndefined();
  expect(parseConfig(settings, secrets, process.cwd()).coordinatorTerminal).toBe(coordinatorTerminal);
});
for (const field of Object.keys(settings)) {
  if (field !== 'coordinatorTerminal') test(`configuration names missing required field ${field}`, () => {
    const value: Record<string, unknown> = { ...settings };
    delete value[field];
    expect(() => parseConfig(value, secrets, process.cwd())).toThrow(field);
  });
  test(`configuration names malformed required field ${field}`, () => {
    expect(() => parseConfig({ ...settings, [field]: {} }, secrets, process.cwd())).toThrow(field);
  });
}
for (const field of Object.keys(secrets)) {
  test(`configuration names missing or malformed secret ${field} without exposing it`, () => {
    for (const value of [undefined, '', 'bad-token']) {
      expect(() => parseConfig(settings, { ...secrets, [field]: value }, process.cwd())).toThrow(field);
    }
  });
}
test('configuration validates nested repositories, owner membership, duplicates, and durations', () => {
  for (const field of ['id', 'name', 'aliases', 'path', 'github']) {
    const repository: Record<string, unknown> = { ...settings.repositories[0] };
    delete repository[field];
    expect(() => parseConfig({ ...settings, repositories: [repository] }, secrets, process.cwd())).toThrow(`repositories[0].${field}`);
    repository[field] = {};
    expect(() => parseConfig({ ...settings, repositories: [repository] }, secrets, process.cwd())).toThrow(`repositories[0].${field}`);
  }
  expect(() => parseConfig({ ...settings, allowedUsers: ['U00000003'] }, secrets, process.cwd())).toThrow('ownerId');
  expect(() => parseConfig({ ...settings, repositories: [] }, secrets, process.cwd())).toThrow('repositories');
  expect(() => parseConfig({ ...settings, repositories: [settings.repositories[0], settings.repositories[0]] }, secrets, process.cwd())).toThrow('repositories');
  for (const field of ['retentionDays', 'shutdownTimeoutMs']) {
    expect(() => parseConfig({ ...settings, [field]: 0 }, secrets, process.cwd())).toThrow(field);
    expect(() => parseConfig({ ...settings, [field]: '5' }, secrets, process.cwd())).toThrow(field);
  }
});
test('configuration loads an ignored JSON file, resolves paths, and redacts every logger level', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-config-'));
  roots.push(root);
  const file = join(root, 'config.local.json');
  writeFileSync(file, JSON.stringify(settings));
  const config = loadConfig(file, secrets, root);
  expect(config.archiveDirectory).toBe(join(root, '..', 'archive'));
  expect(config.retentionDays).toBe(30);
  const lines: string[] = [];
  const log = redactingLog(secrets, (level, message) => lines.push(`${level} ${message}`));
  for (const level of ['debug', 'info', 'warn', 'error']) log(level, new Error(Object.values(secrets).join(' ')));
  for (const token of Object.values(secrets)) expect(lines.join('\n')).not.toContain(token);
  expect(lines).toHaveLength(4);
  writeFileSync(file, '{broken');
  expect(() => loadConfig(file, secrets, root)).toThrow('config');
});
