import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { CliOrca } from '../src/orca.js';
import { Bridge, type SlackEvent } from '../src/slack.js';
import { Store } from '../src/store.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
const event: SlackEvent = { installationId: 'app', eventId: 'event-1', channel: 'C1', ts: '2', threadTs: '1',
  user: 'U1', text: 'Keep the export on one page' };
function seed(store: Store) {
  store.saveThread({ id: 'thread', channel: 'C1', threadTs: '1', owner: 'U1' });
  store.saveWorktree({ id: 'tree', threadId: 'thread', repository: 'example/web', branch: 'feat/export' });
  store.replaceLead({ id: 'session', threadId: 'thread', worktreeId: 'tree', runId: 'run',
    taskId: 'task', dispatchId: 'dispatch', handle: 'handle' });
}
function boundary() {
  const commands: string[][] = [];
  const refused: string[] = [];
  const actions: string[] = [];
  const orca = new CliOrca(async args => { commands.push(args); return { stdout: '{"ok":true,"result":{}}' }; });
  const slack = {
    refuse: async (channel: string, user: string) => { refused.push(`${channel}:${user}`); },
    ownerAction: async (action: { actionId: string }) => { actions.push(action.actionId); },
  };
  return { orca, slack, commands, refused, actions };
}

test('saved inbound message replays after a crash before forwarding and redelivery does not forward twice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-inbound-'));
  roots.push(root);
  const file = join(root, 'ledger.sqlite');
  const ports = boundary();
  let store = new Store(file);
  seed(store);
  await expect(new Bridge(ports.orca, ports.slack, store, ['U1', 'U2'], 'BOT', () => {
    throw new Error('Bridge crashed');
  }).event(event)).rejects.toThrow('Bridge crashed');
  expect(ports.commands).toEqual([]);
  store.close();
  store = new Store(file);
  try {
    const restarted = new Bridge(ports.orca, ports.slack, store, ['U1', 'U2'], 'BOT');
    await restarted.replay();
    await restarted.event(event);
    await restarted.event({ ...event, eventId: 'dual-event' });
    expect(ports.commands).toEqual([
      ['orchestration', 'send', '--to', 'dispatch:dispatch', '--run', 'run', '--type', 'status',
        '--subject', 'Slack follow-up', '--body', 'Keep the export on one page', '--json', '--full'],
    ]);
    expect(store.inbound('thread')).toMatchObject([{ text: event.text, state: 'forwarded' }]);
  } finally { store.close(); }
});

test('concurrent Slack event copies share one forward', async () => {
  const store = new Store(':memory:');
  seed(store);
  const ports = boundary();
  try {
    const bridge = new Bridge(ports.orca, ports.slack, store, ['U1', 'U2'], 'BOT');
    await Promise.all([bridge.event(event), bridge.event({ ...event, eventId: 'dual-event' })]);
    expect(ports.commands).toHaveLength(1);
  } finally { store.close(); }
});

test.each([
  { user: 'OUTSIDER', text: '<@BOT> Do this', state: undefined, forwards: 0, refused: true },
  { user: 'U2', text: 'A private note in this thread', state: 'archived', forwards: 0, refused: false },
  { user: 'U2', text: '<@BOT> Please include CSV', state: 'forwarded', forwards: 1, refused: false },
  { user: 'U1', text: 'Please include CSV', state: 'forwarded', forwards: 1, refused: false },
])('$user message "$text" has state $state and $forwards forwards', async ({ user, text, state, forwards, refused }) => {
  const store = new Store(':memory:');
  seed(store);
  const ports = boundary();
  try {
    await new Bridge(ports.orca, ports.slack, store, ['U1', 'U2'], 'BOT').event({ ...event, user, text });
    expect(store.inbound('thread').map(row => row.state)).toEqual(state ? [state] : []);
    expect(ports.commands).toHaveLength(forwards);
    expect(ports.refused).toEqual(refused ? ['C1:OUTSIDER'] : []);
  } finally { store.close(); }
});

test.each(['U1', 'U2'])('allowlisted %s can stop without a bot mention', async user => {
  const store = new Store(':memory:');
  seed(store);
  const ports = boundary();
  try {
    await new Bridge(ports.orca, ports.slack, store, ['U1', 'U2'], 'BOT').event({ ...event, user, text: '!stop' });
    expect(ports.commands).toEqual([['orchestration', 'worker-stop', '--dispatch', 'dispatch', '--json', '--full']]);
  } finally { store.close(); }
});

test.each(['decision', 'retry', 'cleanup', 'switch-repository', 'stop'] as const)(
  'the %s button enforces owner and allowlist permissions', async actionId => {
    for (const user of ['U1', 'U2', 'OUTSIDER']) {
      const store = new Store(':memory:');
      seed(store);
      store.saveDecision({ id: 'question', threadId: 'thread', options: ['continue'], slackTs: '3' });
      const ports = boundary();
      try {
        const allowed = await new Bridge(ports.orca, ports.slack, store, ['U1', 'U2'], 'BOT').action({
          actionId, threadId: 'thread', channel: 'C1', user, decisionId: 'question', option: 'continue',
        });
        const expected = user === 'U1' || (user === 'U2' && actionId === 'stop');
        expect(allowed).toBe(expected);
        expect(ports.commands.length + ports.actions.length).toBe(expected ? 1 : 0);
        if (actionId === 'decision') expect(store.decision('question')?.answeredBy).toBe(expected ? user : undefined);
      } finally { store.close(); }
    }
  });

test('archived peer text never enters a later agent prompt', async () => {
  const store = new Store(':memory:');
  seed(store);
  const ports = boundary();
  try {
    const bridge = new Bridge(ports.orca, ports.slack, store, ['U1', 'U2'], 'BOT');
    await bridge.event({ ...event, user: 'U2', text: 'Archive this without forwarding' });
    await bridge.event({ ...event, ts: '3', eventId: 'next', text: 'Continue the export' });
    expect(ports.commands.map(args => args[args.indexOf('--body') + 1])).toEqual(['Continue the export']);
    expect(store.inbound('thread').map(row => row.state)).toEqual(['archived', 'forwarded']);
  } finally { store.close(); }
});

test('a new mentioned thread waits durably for a lead and can replay on the chosen worktree', async () => {
  const store = new Store(':memory:');
  const ports = boundary();
  try {
    const bridge = new Bridge(ports.orca, ports.slack, store, ['U1'], 'BOT');
    await bridge.event({ ...event, threadTs: undefined, text: '<@BOT> Export orders' });
    const thread = store.findThread('C1', '2')!;
    expect(thread.owner).toBe('U1');
    expect(store.inbound(thread.id)[0].state).toBe('pending');
    expect(ports.commands).toEqual([]);
    store.saveWorktree({ id: 'tree', threadId: thread.id, repository: 'example/api', branch: 'feat/export' });
    store.replaceLead({ id: 'session', threadId: thread.id, worktreeId: 'tree', runId: 'run',
      taskId: 'task', dispatchId: 'dispatch', handle: 'handle' });
    await bridge.replay();
    expect(ports.commands[0]).toContain('Export orders');
    expect(store.inbound(thread.id)[0].state).toBe('forwarded');
  } finally { store.close(); }
});

test('a failed Orca forward stays pending for replay', async () => {
  const store = new Store(':memory:');
  seed(store);
  const ports = boundary();
  try {
    const failing = new CliOrca(async () => ({ stdout: '{"ok":false,"error":{"message":"unavailable"}}' }));
    await expect(new Bridge(failing, ports.slack, store, ['U1'], 'BOT').event(event)).rejects.toThrow('unavailable');
    expect(store.inbound('thread')[0].state).toBe('pending');
    await new Bridge(ports.orca, ports.slack, store, ['U1'], 'BOT').replay();
    expect(ports.commands).toHaveLength(1);
  } finally { store.close(); }
});

test('invalid, cross-thread, and already answered decisions never produce another reply', async () => {
  const store = new Store(':memory:');
  seed(store);
  store.saveDecision({ id: 'question', threadId: 'thread', options: ['continue'], slackTs: '3' });
  store.saveThread({ id: 'other', channel: 'C1', threadTs: '10', owner: 'U1' });
  store.saveDecision({ id: 'other-question', threadId: 'other', options: ['continue'], slackTs: '11' });
  const ports = boundary();
  try {
    const bridge = new Bridge(ports.orca, ports.slack, store, ['U1'], 'BOT');
    const action = { actionId: 'decision' as const, threadId: 'thread', channel: 'C1', user: 'U1',
      decisionId: 'question', option: 'continue' };
    expect(await bridge.action({ ...action, option: 'unlisted' })).toBe(false);
    expect(await bridge.action({ ...action, decisionId: 'other-question' })).toBe(false);
    expect(await bridge.action({ ...action, channel: 'C2' })).toBe(false);
    expect(await bridge.action(action)).toBe(true);
    expect(await bridge.action(action)).toBe(false);
    expect(ports.commands).toHaveLength(1);
  } finally { store.close(); }
});

test('an outsider stop message is refused without storage or an Orca command', async () => {
  const store = new Store(':memory:');
  seed(store);
  const ports = boundary();
  try {
    await new Bridge(ports.orca, ports.slack, store, ['U1', 'U2'], 'BOT').event({ ...event, user: 'OUTSIDER', text: '!stop' });
    expect(store.inbound()).toEqual([]);
    expect(ports.commands).toEqual([]);
    expect(ports.refused).toEqual(['C1:OUTSIDER']);
  } finally { store.close(); }
});

test('a successful stop retires the lead session and preserves the thread and worktree', async () => {
  const store = new Store(':memory:');
  seed(store);
  const ports = boundary();
  try {
    await new Bridge(ports.orca, ports.slack, store, ['U1', 'U2'], 'BOT').event({ ...event, user: 'U2', text: '!stop' });
    expect(store.leadSessions('thread')[0].active).toBe(false);
    expect(store.thread('thread')?.owner).toBe('U1');
    expect(store.worktrees('thread')).toHaveLength(1);
  } finally { store.close(); }
});
