import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Repository } from './routing.js';

export interface Config {
  checkout: string; botId: string; ownerId: string; allowedUsers: string[];
  runId: string; coordinatorTerminal?: string; agent: string;
  archiveDirectory: string; hooksDirectory: string; retentionDays: number; shutdownTimeoutMs: number;
  repositories: (Repository & { path: string; github: string })[];
}
export type Log = (level: string, message: unknown) => void;
function invalid(field: string): never { throw new Error(`Invalid or missing configuration field ${field}`); }
export function parseConfig(value: unknown, env: NodeJS.ProcessEnv, checkout: string): Config {
  for (const [field, prefix] of [['SLACK_BOT_TOKEN', 'xoxb-'], ['SLACK_APP_TOKEN', 'xapp-']]) {
    const token = env[field];
    if (!token?.startsWith(prefix) || token.length <= prefix.length || /\s/.test(token)) invalid(field);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('config');
  const raw = value as Record<string, unknown>;
  const text = (object: Record<string, unknown>, key: string, field = key): string => {
    const item = object[key];
    if (typeof item !== 'string' || !item.trim() || item !== item.trim() || /[\x00-\x1f]/.test(item)) invalid(field);
    return item;
  };
  const id = (key: string, pattern: RegExp) => {
    const item = text(raw, key);
    if (!pattern.test(item)) invalid(key);
    return item;
  };
  const users = raw.allowedUsers;
  if (!Array.isArray(users) || !users.length || users.some(user => typeof user !== 'string' || !/^U[A-Z0-9]{8,}$/.test(user)) ||
      new Set(users).size !== users.length) invalid('allowedUsers');
  const botId = id('botId', /^U[A-Z0-9]{8,}$/), ownerId = id('ownerId', /^U[A-Z0-9]{8,}$/);
  if (!users.includes(ownerId)) invalid('ownerId');
  if (users.includes(botId)) invalid('allowedUsers');
  const duration = (key: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER) => {
    const item = raw[key] ?? fallback;
    if (typeof item !== 'number' || !Number.isFinite(item) || item <= 0 || item > maximum) invalid(key);
    return item;
  };
  if (!Array.isArray(raw.repositories) || !raw.repositories.length) invalid('repositories');
  const repositories = raw.repositories.map((repository: unknown, index: number) => {
    const field = `repositories[${index}]`;
    if (!repository || typeof repository !== 'object' || Array.isArray(repository)) invalid(field);
    const item = repository as Record<string, unknown>;
    const get = (key: string) => text(item, key, `${field}.${key}`);
    const aliases = item.aliases;
    if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string' || !alias.trim())) invalid(`${field}.aliases`);
    const github = get('github');
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(github)) invalid(`${field}.github`);
    return { id: get('id'), name: get('name'), aliases: aliases as string[], path: resolve(checkout, get('path')), github };
  });
  if (new Set(repositories.map(repository => repository.id)).size !== repositories.length ||
      new Set(repositories.map(repository => repository.path)).size !== repositories.length) invalid('repositories');
  return { checkout: resolve(checkout), botId, ownerId, allowedUsers: users as string[],
    runId: id('runId', /^run_[a-zA-Z0-9-]+$/), coordinatorTerminal: raw.coordinatorTerminal === undefined ? undefined : id('coordinatorTerminal', /^term_[a-zA-Z0-9-]+$/),
    agent: id('agent', /^[a-zA-Z0-9_-]+$/), repositories,
    archiveDirectory: resolve(checkout, text(raw, 'archiveDirectory')),
    hooksDirectory: resolve(checkout, text(raw, 'hooksDirectory')),
    retentionDays: duration('retentionDays', 30), shutdownTimeoutMs: duration('shutdownTimeoutMs', 25_000, 25_000) };
}
export function loadConfig(file: string, env = process.env, checkout = process.cwd()): Config {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch { invalid('config'); }
  return parseConfig(value, env, checkout);
}
export function redactingLog(env: NodeJS.ProcessEnv,
  write: (level: string, message: string) => void = (level, message) => {
    process.stdout.write(`${new Date().toISOString()} pid=${process.pid} ${level} ${message}\n`);
  }): Log {
  const tokens = [env.SLACK_BOT_TOKEN, env.SLACK_APP_TOKEN].filter((token): token is string => !!token);
  return (level, value) => {
    let message: string;
    try { message = value instanceof Error ? value.message : typeof value === 'string' ? value : JSON.stringify(value); }
    catch { message = '[unserializable]'; }
    for (const token of tokens) message = String(message).replaceAll(token, '[redacted]');
    write(level, String(message).replace(/xox[baprs]-[^\s"'<>]+|xapp-[^\s"'<>]+/g, '[redacted]'));
  };
}
