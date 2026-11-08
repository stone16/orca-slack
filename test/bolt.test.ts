import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, type ReceiverEvent } from '@slack/bolt';
import { afterEach, expect, test, vi } from 'vitest';
import { CliOrca } from '../src/orca.js';
import { Store } from '../src/store.js';
import { SlackAdapter, createSocketMode, registerHandlers, type SlackClient } from '../src/bolt.js';
import { type StatusView } from '../src/render.js';

const events = JSON.parse(readFileSync(new URL('./fixtures/slack-events.json', import.meta.url), 'utf8'));
const actionFixture = JSON.parse(readFileSync(new URL('./fixtures/slack-action.json', import.meta.url), 'utf8'));
const stores: Store[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
  vi.unstubAllEnvs();
});
const initial: StatusView = { threadId: 'thread', title: 'Export orders', state: 'implementing', worktrees: [
  { id: 'tree', repository: 'example/web', branch: 'feat/export', state: 'implementing', hasCommits: false, agentActive: true },
] };
function setup(file = ':memory:') {
  const store = new Store(file);
  stores.push(store);
  store.saveThread({ id: 'thread', channel: 'C1', threadTs: '1700000000.000001', owner: 'U1' });
  store.saveWorktree({ id: 'tree', threadId: 'thread', repository: 'example/web', branch: 'feat/export' });
  store.replaceLead({ id: 'session', threadId: 'thread', worktreeId: 'tree', runId: 'run',
    taskId: 'task', dispatchId: 'dispatch', handle: 'handle' });
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  let counter = 10;
  const client: SlackClient = {
    chat: {
      postMessage: async args => { calls.push({ method: 'post', args: { ...args } }); return { ts: `${counter++}.0` }; },
      update: async args => { calls.push({ method: 'update', args: { ...args } }); },
      postEphemeral: async args => { calls.push({ method: 'ephemeral', args }); },
    },
    reactions: { add: async args => { calls.push({ method: 'reaction', args }); } },
    views: { open: async args => { calls.push({ method: 'modal', args: { ...args } }); } },
  };
  const commands: string[][] = [];
  const timeline: string[] = [];
  const orca = new CliOrca(async args => { timeline.push(`orca:${args[1]}`); commands.push(args); return { stdout: '{"ok":true,"result":{}}' }; });
  const ownerActions: string[] = [];
  let view = structuredClone(initial);
  const options = { orca, allowedUsers: ['U1', 'U2'], botId: 'BOT',
    statusView: async () => view,
    ownerAction: async (action: { actionId: string }) => { ownerActions.push(action.actionId); },
    logTail: async () => 'line 1\n<@U2> is log data',
  };
  const adapter = new SlackAdapter(client, store, options);
  const receiver = { init: () => {}, start: async () => {}, stop: async () => {} };
  const app = new App({ receiver, token: 'fixture-token', botId: 'B1', botUserId: 'BOT', tokenVerificationEnabled: false });
  const errors: unknown[] = [];
  app.error(async error => { errors.push(error); });
  registerHandlers(app, adapter);
  const acked: string[] = [];
  const deliver = async (body: ReceiverEvent['body']) => {
    await app.processEvent({ body, ack: async () => { timeline.push('ack'); acked.push(body.type as string); } });
    expect(errors).toEqual([]);
  };
  return { store, client, adapter, app, calls, commands, ownerActions, options, deliver, acked, timeline,
    changeView: (next: StatusView) => { view = next; } };
}
function click(actionId: string, value: object, ts: string, user = 'U1') {
  const body = structuredClone(actionFixture);
  body.actions[0].action_id = actionId;
  body.actions[0].value = JSON.stringify(value);
  body.user.id = user;
  body.message.ts = ts;
  body.container.message_ts = ts;
  return body;
}

test('recorded message and mention payloads retain dedup fields and bot or edited messages are ignored', async () => {
  const { deliver, store, commands, calls } = setup();
  for (const body of events) await deliver(body);
  expect(store.inbound('thread').map(({ installationId, eventId, channel, ts, threadTs, text, state }) =>
    ({ installationId, eventId, channel, ts, threadTs, text, state }))).toEqual([
    { installationId: 'A1:T1', eventId: 'Ev-message', channel: 'C1', ts: '1700000000.000001',
      threadTs: undefined, text: '<@BOT> Export orders', state: 'forwarded' },
    { installationId: 'A1:T1', eventId: 'Ev-followup', channel: 'C1', ts: '1700000001.000001',
      threadTs: '1700000000.000001', text: 'Keep one page', state: 'forwarded' },
  ]);
  expect(commands.map(args => args[args.indexOf('--body') + 1])).toEqual(['Export orders', 'Keep one page']);
  expect(new Set(calls.filter(call => call.method === 'reaction').map(call => call.args.name)))
    .toEqual(new Set(['eyes', 'white_check_mark']));
});

test('status updates use the saved timestamp after reopening and concurrent first updates post once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'slack-card-'));
  roots.push(root);
  const file = join(root, 'ledger.sqlite');
  const { adapter, calls, store, client, options } = setup(file);
  await Promise.all([adapter.status(initial), adapter.status(initial)]);
  expect(calls.filter(call => call.method === 'post')).toHaveLength(1);
  const reopened = new Store(file);
  stores.push(reopened);
  const restarted = new SlackAdapter(client, reopened, options);
  await restarted.status({ ...initial, state: 'unknown' });
  await restarted.status({ ...initial, state: 'interrupted' });
  expect(calls.filter(call => call.method === 'update').map(call => call.args.ts)).toEqual(['10.0', '10.0', '10.0']);
  expect(calls.filter(call => call.method === 'reaction')).toEqual([]);
  expect(store.slackCard('thread', 'status')?.ts).toBe('10.0');
});

test('a received prompt gets no forwarded check mark until Orca delivery succeeds', async () => {
  const { adapter, store, calls } = setup();
  store.endLead('session');
  await adapter.event({ installationId: 'A1:T1', eventId: 'Ev-queued', channel: 'C1', ts: '1700000005.000001',
    threadTs: '1700000000.000001', user: 'U1', text: 'Continue' });
  expect(calls.filter(call => call.method === 'reaction').map(call => call.args.name)).toEqual(['eyes']);
  expect(store.inbound('thread')[0].state).toBe('pending');
});

test('decision button acknowledges then replies through Bridge once and updates the decision in place', async () => {
  const { adapter, deliver, commands, calls, acked, store, timeline } = setup();
  await adapter.decision({ threadId: 'thread', id: 'question', owner: 'U1', question: 'Continue?', options: ['Continue', 'Pause'] });
  await deliver(actionFixture);
  await deliver(actionFixture);
  expect(acked).toEqual(['block_actions', 'block_actions']);
  expect(timeline.slice(0, 2)).toEqual(['ack', 'orca:reply']);
  expect(commands).toEqual([['orchestration', 'reply', '--id', 'question', '--body', 'Continue', '--run', 'run', '--json', '--full']]);
  expect(store.decision('question')?.answeredBy).toBe('U1');
  const updates = calls.filter(call => call.method === 'update' && call.args.ts === '10.0');
  expect(updates.length).toBeGreaterThan(0);
  expect(JSON.stringify(updates.at(-1)?.args.blocks)).toContain('已选择 Continue');
  expect(JSON.stringify(updates.at(-1)?.args.blocks)).not.toContain('"type":"button"');
});

test('a refusal reaches only the refused user and log tail opens a plain text modal', async () => {
  const { adapter, deliver, calls, ownerActions, commands, store } = setup();
  await adapter.result({ threadId: 'thread', id: 'failure', owner: 'U1', outcome: 'failed', text: 'Checks failed' });
  await deliver(click('retry', { threadId: 'thread', resultId: 'failure' }, '10.0', 'U2'));
  await deliver(click('log-tail', { threadId: 'thread', resultId: 'failure' }, '10.0', 'OUTSIDER'));
  const outsider = structuredClone(events[0]);
  outsider.event.user = 'OUTSIDER';
  await deliver(outsider);
  expect(calls.filter(call => call.method === 'ephemeral').map(call => call.args.user)).toEqual(['U2', 'OUTSIDER', 'OUTSIDER']);
  expect(calls.filter(call => call.method === 'post')).toHaveLength(1);
  expect(ownerActions).toEqual([]);
  expect(commands).toEqual([]);
  expect(store.inbound()).toEqual([]);
  await deliver(click('log-tail', { threadId: 'thread', resultId: 'failure' }, '10.0'));
  expect(calls.filter(call => call.method === 'modal')).toEqual([{ method: 'modal', args: {
    trigger_id: 'fixture-trigger', view: { type: 'modal', title: { type: 'plain_text', text: '日志尾部' },
      close: { type: 'plain_text', text: '关闭' }, blocks: [
        { type: 'section', text: { type: 'plain_text', text: 'line 1\n<@U2> is log data' } },
      ] },
  } }]);
  expect(calls.filter(call => call.method === 'post')).toHaveLength(1);
});

test('status and failure buttons reach Bridge actions and stale message timestamps cannot act', async () => {
  const { adapter, deliver, commands, ownerActions, changeView, calls } = setup();
  await adapter.status(initial);
  await deliver(click('switch-repository', { threadId: 'thread' }, '10.0'));
  await deliver(click('switch-repository', { threadId: 'thread' }, '10.0'));
  expect(ownerActions).toEqual(['switch-repository']);
  expect(JSON.stringify(calls.filter(call => call.method === 'update' && call.args.ts === '10.0'))).toContain('已点击');
  changeView({ ...initial, worktrees: [{ ...initial.worktrees[0], hasCommits: true }] });
  await deliver(click('switch-repository', { threadId: 'thread' }, '10.0'));
  await deliver(click('stop', { threadId: 'thread' }, 'stale'));
  expect(commands).toEqual([]);
  await deliver(click('stop', { threadId: 'thread' }, '10.0', 'U2'));
  expect(commands).toEqual([['orchestration', 'worker-stop', '--dispatch', 'dispatch', '--json', '--full']]);
  await adapter.result({ threadId: 'thread', id: 'failure', owner: 'U1', outcome: 'failed', text: 'Checks failed' });
  await deliver(click('retry', { threadId: 'thread', resultId: 'failure' }, '11.0'));
  await adapter.result({ threadId: 'thread', id: 'failure', owner: 'U1', outcome: 'failed', text: 'Checks failed' });
  await deliver(click('retry', { threadId: 'thread', resultId: 'failure' }, '11.0'));
  expect(ownerActions).toEqual(['switch-repository', 'retry']);
  expect(JSON.stringify(calls.filter(call => call.method === 'update' && call.args.ts === '11.0'))).toContain('已重试');
});

test('tokens are required from the environment and library logs redact both tokens', () => {
  const { store, options } = setup();
  vi.stubEnv('SLACK_BOT_TOKEN', '');
  vi.stubEnv('SLACK_APP_TOKEN', '');
  expect(() => createSocketMode(store, options)).toThrow('SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required');
  vi.stubEnv('SLACK_BOT_TOKEN', 'fixture-bot-secret');
  vi.stubEnv('SLACK_APP_TOKEN', 'fixture-app-secret');
  const logs: string[] = [];
  const runtime = createSocketMode(store, options, (_level, message) => { logs.push(message); });
  expect(runtime.app.client.token).toBe(process.env.SLACK_BOT_TOKEN);
  runtime.app.logger.error({ token: process.env.SLACK_BOT_TOKEN }, new Error(process.env.SLACK_APP_TOKEN));
  expect(logs.join(' ')).toContain('[redacted]');
  expect(logs.join(' ')).not.toContain('fixture-bot-secret');
  expect(logs.join(' ')).not.toContain('fixture-app-secret');
});

test('simultaneous decision publication saves one decision and one Slack message', async () => {
  const { adapter, store, calls } = setup();
  const decision = { threadId: 'thread', id: 'question', owner: 'U1', question: 'Continue?', options: ['Continue'] };
  await Promise.all([adapter.decision(decision), adapter.decision(decision)]);
  expect(calls.filter(call => call.method === 'post')).toHaveLength(1);
  expect(store.decision('question')?.slackTs).toBe('10.0');
});

test('a failed update retries the original card without posting another message', async () => {
  const { adapter, client, calls, store } = setup();
  await adapter.status(initial);
  const update = client.chat.update;
  client.chat.update = async () => { throw new Error('Slack unavailable'); };
  await expect(adapter.status({ ...initial, state: 'unknown' })).rejects.toThrow('Slack unavailable');
  expect(store.slackCard('thread', 'status')?.ts).toBe('10.0');
  client.chat.update = update;
  await adapter.status({ ...initial, state: 'interrupted' });
  expect(calls.filter(call => call.method === 'post')).toHaveLength(1);
  expect(calls.filter(call => call.method === 'update').map(call => call.args.ts)).toEqual(['10.0']);
});

test('cleanup clicks use the current state and reach the owner handler only when eligible', async () => {
  const { adapter, changeView, deliver, ownerActions } = setup();
  const view: StatusView = { ...initial, state: 'awaiting-verification', worktrees: [{ ...initial.worktrees[0],
    agentActive: false, pullRequest: { number: 1, url: 'https://github.com/example/web/pull/1', state: 'merged' } }] };
  await adapter.status(view);
  await deliver(click('cleanup', { threadId: 'thread' }, '10.0'));
  expect(ownerActions).toEqual([]);
  changeView(view);
  await deliver(click('cleanup', { threadId: 'thread' }, '10.0', 'U2'));
  expect(ownerActions).toEqual([]);
  await deliver(click('cleanup', { threadId: 'thread' }, '10.0'));
  await deliver(click('cleanup', { threadId: 'thread' }, '10.0'));
  expect(ownerActions).toEqual(['cleanup']);
});

test('a failed Orca forward keeps a durable prompt and only the received reaction', async () => {
  const { client, store, options, calls } = setup();
  const adapter = new SlackAdapter(client, store, { ...options, orca: new CliOrca(async () => {
    return { stdout: '{"ok":false,"error":{"message":"Orca unavailable"}}' };
  }) });
  await expect(adapter.event({ installationId: 'A1:T1', eventId: 'Ev-fail', channel: 'C1', ts: '4',
    threadTs: '1700000000.000001', user: 'U1', text: 'Continue' })).rejects.toThrow('Orca unavailable');
  expect(store.inbound('thread')[0].state).toBe('pending');
  expect(calls.filter(call => call.method === 'reaction').map(call => call.args.name)).toEqual(['eyes']);
});

test('malformed and cross-channel button values cannot reach Orca, owner actions, or log modals', async () => {
  const { adapter, deliver, commands, ownerActions, calls } = setup();
  await adapter.status(initial);
  const malformed = click('stop', { threadId: 'thread' }, '10.0');
  for (const value of ['null', '[]', 'not-json', '{}', '{"threadId":4}']) {
    malformed.actions[0].value = value;
    await deliver(malformed);
  }
  const otherChannel = click('stop', { threadId: 'thread' }, '10.0');
  otherChannel.channel.id = 'C2';
  await deliver(otherChannel);
  await deliver(click('decision_0', { threadId: 'thread', decisionId: 'missing', option: 'Continue' }, '10.0'));
  await deliver(click('log-tail', { threadId: 'thread', resultId: 'missing' }, '10.0'));
  expect(commands).toEqual([]);
  expect(ownerActions).toEqual([]);
  expect(calls.filter(call => call.method === 'modal')).toEqual([]);
});

test('the Socket Mode receiver carries recorded envelopes to the real Bridge and redacts listener errors', async () => {
  const { store, options, client, commands, calls } = setup();
  vi.stubEnv('SLACK_BOT_TOKEN', 'fixture-bot-secret');
  vi.stubEnv('SLACK_APP_TOKEN', 'fixture-app-secret');
  const logs: string[] = [];
  const runtime = createSocketMode(store, options, (_level, message) => { logs.push(message); });
  Object.assign(runtime.app.client.chat, client.chat);
  Object.assign(runtime.app.client.reactions, client.reactions);
  Object.assign(runtime.app.client.views, client.views);
  runtime.app.client.auth.test = async () => ({ ok: true, user_id: 'BOT', bot_id: 'B1' });
  const listeners = runtime.socket.listeners('slack_event');
  expect(listeners).toHaveLength(1);
  const acknowledgements: unknown[] = [];
  await listeners[0]({ body: events[0], ack: async (response: unknown) => { acknowledgements.push(response); } });
  expect(acknowledgements).toHaveLength(1);
  expect(commands).toHaveLength(1);
  expect(store.inbound('thread')[0].eventId).toBe('Ev-message');
  expect(calls.filter(call => call.method === 'post')).toHaveLength(1);
  runtime.app.client.chat.update = async () => { throw new Error(`Remote failure ${process.env.SLACK_BOT_TOKEN} ${process.env.SLACK_APP_TOKEN}`); };
  await listeners[0]({ body: events[2], ack: async () => {} });
  expect(logs.join(' ')).toContain('[redacted]');
  expect(logs.join(' ')).not.toContain('fixture-bot-secret');
  expect(logs.join(' ')).not.toContain('fixture-app-secret');
});
