import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export interface ChannelConfig { repo: string; agent: string; model: string; effort: string }
export interface Config {
  channels: Record<string, ChannelConfig>;
  allowedUsers: string[];
  opsChannel: string;
  heartbeatFile: string;
  dbFile: string;
}
export function loadConfig(file: string): Config {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Object.keys(value).every(k => ['channels', 'allowedUsers', 'opsChannel', 'heartbeatFile', 'dbFile'].includes(k)) ||
      !value.channels || typeof value.channels !== 'object' || Array.isArray(value.channels) ||
      !Object.keys(value.channels).length ||
      !Object.entries(value.channels).every(([id, route]) => /^C[A-Z0-9]+$/.test(id) &&
        route && typeof route === 'object' && Object.keys(route).every(k => ['repo', 'agent', 'model', 'effort'].includes(k)) && ['repo', 'agent', 'model', 'effort'].every(k => text((route as Record<string, unknown>)[k]))) ||
      !Array.isArray(value.allowedUsers) || !value.allowedUsers.length ||
      !value.allowedUsers.every((id: unknown) => typeof id === 'string' && /^U[A-Z0-9]+$/.test(id)) ||
      typeof value.opsChannel !== 'string' || !/^C[A-Z0-9]+$/.test(value.opsChannel) ||
      !text(value.heartbeatFile) || !text(value.dbFile)) throw new Error('Invalid config: channels, allowedUsers, opsChannel, heartbeatFile and dbFile are required');
  const path = (p: string) => resolve(dirname(resolve(file)), p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p);
  return { channels: value.channels, allowedUsers: value.allowedUsers, opsChannel: value.opsChannel,
    heartbeatFile: path(value.heartbeatFile), dbFile: path(value.dbFile) };
}
