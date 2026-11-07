import { vi } from 'vitest';
import type { Slack } from '../src/render.js';
import type { Config } from '../src/config.js';
export const config: Config = {
  channels: { C1: { repo: 'name:repo', agent: 'codex', model: 'model', effort: 'high' } },
  allowedUsers: ['U1'], opsChannel: 'COPS', heartbeatFile: '/tmp/heartbeat', dbFile: ':memory:',
};
export const thread = { thread_ts: '1.1', channel: 'C1', run_id: 'r1', task_id: 't1', dispatch_id: 'd1', worktree: '/tmp/work', repo: 'name:repo', requester: 'U1', status: 'running' };
export function fakeSlack() {
  const chat = {
    postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '2.2' }),
    postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
    update: vi.fn().mockResolvedValue({ ok: true }),
    getPermalink: vi.fn().mockResolvedValue({ ok: true, permalink: 'https://slack.test/thread' }),
  };
  const reactions = { add: vi.fn().mockResolvedValue({ ok: true }) };
  return { chat, reactions, client: { chat, reactions } as unknown as Slack };
}
