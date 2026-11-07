import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { config } from './helpers.js';
function file(value: unknown) {
  const path = join(mkdtempSync(join(tmpdir(), 'orca-config-')), 'config.json');
  writeFileSync(path, JSON.stringify(value)); return path;
}
it('loads the example without credentials and resolves local paths', () => {
  const parsed = loadConfig('config.example.json');
  expect(isAbsolute(parsed.dbFile)).toBe(true); expect(parsed.allowedUsers).toHaveLength(1);
  expect(parsed).not.toHaveProperty('token');
});
it.each([
  { ...config, allowedUsers: [] }, { ...config, allowedUsers: ['someone'] },
  { ...config, channels: {} }, { ...config, channels: { C1: { repo: 'r' } } },
  { ...config, channels: { channel: config.channels.C1 } }, { ...config, opsChannel: '' },
  { ...config, botToken: 'secret' }, { ...config, channels: { C1: { ...config.channels.C1, token: 'secret' } } },
])('rejects invalid config and credential fields %#', value => expect(() => loadConfig(file(value))).toThrow());
