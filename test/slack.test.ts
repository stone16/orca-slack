import type { App } from '@slack/bolt';
import { afterEach, expect, it, vi } from 'vitest';
import { Bridge, registerHandlers } from '../src/slack.js';
import { OrcaError } from '../src/orca.js';
import { Store } from '../src/store.js';
import { config, fakeSlack, thread } from './helpers.js';
const stores: Store[] = [];
afterEach(() => { stores.forEach(s => s.close()); stores.length = 0; });
function setup(tracked = false) {
  const store = new Store(':memory:'); stores.push(store); if (tracked) store.saveThread(thread);
  const slack = fakeSlack();
  const orca = { call: vi.fn().mockResolvedValue({ dispatchId: 'd1', taskId: 't1', runId: 'r1', effects: [{ kind: 'worktree', id: 'repo::/tmp/work' }] }) };
  const bridge = new Bridge(orca, slack.client, store, config, 'r1');
  return { store, slack, orca, bridge };
}
const mention = { eventId: 'e1', channel: 'C1', ts: '1.1', user: 'U1', text: '<@UBOT> build it', botId: 'UBOT', mention: true };
it('reacts before Orca, includes provenance and run, persists and posts a stop button', async () => {
  const { bridge, slack, orca, store } = setup();
  await bridge.event(mention);
  expect(slack.reactions.add.mock.invocationCallOrder[0]).toBeLessThan(orca.call.mock.invocationCallOrder[0]);
  const args = orca.call.mock.calls[0][1] as string[];
  expect(args).toContain('new-child'); expect(args).toContain('--run');
  expect(args[args.indexOf('--spec') + 1]).toContain('https://slack.test/thread');
  expect(args[args.indexOf('--spec') + 1]).toContain('U1');
  expect(args[args.indexOf('--spec') + 1]).toContain('Do not use interactive question tools');
  expect(store.byDispatch('d1')).toMatchObject({ status: 'running', channel: 'C1' });
  expect(JSON.stringify(slack.chat.postMessage.mock.calls)).toContain('stop');
});
it('deduplicates event IDs and message timestamps, including simultaneous dispatches', async () => {
  const { bridge, orca } = setup();
  await Promise.all([bridge.event(mention), bridge.event(mention), bridge.event({ ...mention, eventId: 'e2' })]);
  expect(orca.call).toHaveBeenCalledTimes(1);
});
it('refuses unauthorized entry points ephemerally without other side effects', async () => {
  const { bridge, orca, slack, store } = setup(true); store.saveQuestion('q1', '1.1', ['yes'], '2.2');
  await bridge.event({ ...mention, user: 'UOTHER' });
  await bridge.event({ ...mention, eventId: 'e2', ts: '3.3', threadTs: '1.1', text: '!stop', user: 'UOTHER' });
  await bridge.action({ actionId: 'answer', value: '{"messageId":"q1","option":"yes"}', user: 'UOTHER', channel: 'C1', messageTs: '2.2' });
  await bridge.action({ actionId: 'stop', value: '{"dispatchId":"d1"}', user: 'UOTHER', channel: 'C1', messageTs: '2.2' });
  expect(slack.chat.postEphemeral).toHaveBeenCalledTimes(4);
  expect(orca.call).not.toHaveBeenCalled(); expect(slack.reactions.add).not.toHaveBeenCalled();
});
it('routes tracked mentions as high priority follow-ups, not dispatches', async () => {
  const { bridge, orca, slack } = setup(true);
  await bridge.event({ ...mention, ts: '3.3', threadTs: '1.1' });
  expect(orca.call).toHaveBeenCalledWith('send', ['--to', 'dispatch:d1', '--run', 'r1', '--type', 'status', '--priority', 'high', '--subject', 'Slack follow-up', '--body', 'build it']);
  expect(slack.reactions.add).toHaveBeenCalledWith(expect.objectContaining({ name: 'white_check_mark', timestamp: '3.3' }));
});
it('answers a pending question from free text and updates the card', async () => {
  const { bridge, orca, store, slack } = setup(true); store.saveQuestion('q1', '1.1', ['yes'], '2.2');
  await bridge.event({ ...mention, ts: '3.3', threadTs: '1.1', text: 'custom answer', mention: false });
  expect(orca.call).toHaveBeenCalledWith('reply', ['--id', 'q1', '--body', 'custom answer', '--run', 'r1']);
  expect(store.question('q1')?.answered_by).toBe('U1');
  expect(slack.chat.update).toHaveBeenCalledWith(expect.objectContaining({ ts: '2.2', text: expect.stringContaining('custom answer') }));
});
it('serializes competing question clicks and validates their channel and option', async () => {
  const { bridge, orca, store } = setup(true); store.saveQuestion('q1', '1.1', ['yes'], '2.2');
  const action = { actionId: 'answer', value: '{"messageId":"q1","option":"yes"}', user: 'U1', channel: 'C1', messageTs: '2.2' };
  await bridge.action({ ...action, channel: 'COTHER' });
  await bridge.action({ ...action, value: '{"messageId":"q1","option":"forged"}' });
  await Promise.all([bridge.action(action), bridge.action(action)]);
  expect(orca.call).toHaveBeenCalledTimes(1);
});
it.each(['text', 'button'])('stops and releases exactly once through %s', async mode => {
  const { bridge, orca, store, slack } = setup(true);
  const stop = () => mode === 'text'
    ? bridge.event({ ...mention, ts: '3.3', threadTs: '1.1', text: '!stop', mention: false })
    : bridge.action({ actionId: 'stop', value: '{"dispatchId":"d1"}', user: 'U1', channel: 'C1', messageTs: '2.2' });
  await Promise.all([stop(), stop()]);
  expect(orca.call.mock.calls.map(([verb]) => verb)).toEqual(['worker-stop', 'worker-release']);
  expect(store.byDispatch('d1')?.status).toBe('stopped');
  expect(slack.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: '已停止 by <@U1>' }));
});
it('stores failed start receipts and never retries or releases an unknown outcome', async () => {
  const { bridge, orca, store, slack } = setup();
  orca.call.mockRejectedValue(new OrcaError('setup: failed', { dispatchId: 'd1', taskId: 't1', stage: 'setup', lastError: 'failed' }));
  await bridge.event(mention);
  expect(store.byDispatch('d1')?.status).toBe('failed'); expect(orca.call).toHaveBeenCalledTimes(1);
  expect(slack.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('setup') }));
});
it('ignores bot messages, unconfigured channels and ordinary untracked roots', async () => {
  const { bridge, orca, slack } = setup();
  await bridge.event({ ...mention, user: 'UBOT' });
  await bridge.event({ ...mention, eventId: 'e2', channel: 'COTHER' });
  await bridge.event({ ...mention, eventId: 'e3', mention: false });
  expect(orca.call).not.toHaveBeenCalled(); expect(slack.chat.postMessage).not.toHaveBeenCalled();
});
it('reads the worktree path from the installed CLI effects receipt', async () => {
  const { bridge, orca, store } = setup();
  orca.call.mockResolvedValue({ dispatchId: 'd1', taskId: 't1', runId: 'r1', state: 'ready',
    effects: [{ kind: 'worktree', action: 'created_child', id: 'repo-id::/tmp/child' }] });
  await bridge.event(mention); expect(store.byDispatch('d1')?.worktree).toBe('/tmp/child');
});
it('queues follow-ups during a dispatch instead of dropping or redispatching them', async () => {
  const { bridge, orca } = setup(); let finish: (value: unknown) => void = () => {};
  orca.call.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const start = bridge.event(mention);
  await vi.waitFor(() => expect(orca.call).toHaveBeenCalledTimes(1));
  const followup = bridge.event({ ...mention, eventId: 'e2', ts: '3.3', threadTs: '1.1', text: 'more' });
  finish({ dispatchId: 'd1', taskId: 't1', runId: 'r1', effects: [{ kind: 'worktree', id: 'repo::/tmp/work' }] });
  await Promise.all([start, followup]);
  expect(orca.call.mock.calls.map(([verb]) => verb)).toEqual(['worker-start', 'send']);
});
it('allows explicit stop after escalation marked the thread failed', async () => {
  const { bridge, orca, store } = setup(true); store.setStatus('1.1', 'failed');
  await bridge.event({ ...mention, ts: '3.3', threadTs: '1.1', text: '!stop' });
  expect(orca.call.mock.calls.map(([verb]) => verb)).toEqual(['worker-stop', 'worker-release']);
  expect(store.byDispatch('d1')?.status).toBe('stopped');
});

it('records ignored message subtypes without routing edits as new work', async () => {
  const { bridge, store, orca } = setup();
  const app = { event: vi.fn(), action: vi.fn() };
  registerHandlers(app as unknown as App, bridge, vi.fn());
  const handler = app.event.mock.calls.find(([type]) => type === 'message')![1];
  await handler({ event: { type: 'message', subtype: 'message_changed' }, body: { event_id: 'edit1' }, context: {} });
  expect(store.claim('edit1')).toBe(false); expect(orca.call).not.toHaveBeenCalled();
});

it.each(['mention-first', 'message-first'])('dispatches once when both Slack event types arrive: %s', async order => {
  const { bridge, orca, slack, store } = setup();
  const ordinary = { ...mention, mention: false, eventId: 'message-event' };
  for (const event of order === 'mention-first' ? [mention, ordinary] : [ordinary, mention]) await bridge.event(event);
  expect(orca.call).toHaveBeenCalledTimes(1);
  expect(orca.call).toHaveBeenCalledWith('worker-start', expect.any(Array));
  expect(slack.reactions.add).toHaveBeenCalledTimes(1);
  expect(store.byDispatch('d1')?.ts).toBe(mention.ts);
});
