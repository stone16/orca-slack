import { afterEach, expect, it, vi } from 'vitest';
import { ReportLoop } from '../src/report-loop.js';
import { Store } from '../src/store.js';
import { config, fakeSlack, thread } from './helpers.js';
const stores: Store[] = [];
afterEach(() => { stores.forEach(s => s.close()); stores.length = 0; vi.useRealTimers(); });
function setup() {
  const store = new Store(':memory:'); stores.push(store); store.saveThread(thread);
  const slack = fakeSlack();
  const orca = { call: vi.fn().mockResolvedValue({}) };
  const heartbeat = vi.fn(), log = vi.fn();
  return { store, slack, orca, heartbeat, log, loop: new ReportLoop(orca, slack.client, store, config, 'r1', heartbeat, log) };
}
const done = { id: 'm1', type: 'worker_done', body: 'All done', payload: '{"dispatchId":"d1","outcome":"succeeded","reportPath":"/tmp/report"}' };
it('posts, reacts, releases and marks done before acknowledging a whole delivery', async () => {
  const { loop, slack, orca, store, heartbeat } = setup();
  const controller = new AbortController();
  orca.call.mockImplementation(async (verb: string, args: string[]) => {
    if (verb === 'check' && args.includes('--ack')) { controller.abort(); return { messages: [] }; }
    return verb === 'check' ? { deliveryId: 'del1', messages: [done] } : {};
  });
  await loop.run(controller.signal);
  expect(slack.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '1.1', text: expect.stringContaining('/tmp/report') }));
  expect(slack.reactions.add).toHaveBeenCalledWith({ channel: 'C1', timestamp: '1.1', name: 'white_check_mark' });
  expect(orca.call.mock.calls.map(([verb]) => verb)).toEqual(['check', 'worker-release', 'check']);
  expect(store.byDispatch('d1')?.status).toBe('done');
  expect(heartbeat).toHaveBeenCalled();
});
it('reports failures with a clean 40-line terminal tail, releases and marks failed', async () => {
  const { loop, orca, slack, store } = setup();
  orca.call.mockResolvedValue({ terminal: { tail: Array.from({ length: 50 }, (_, i) => `⠋line${i}`) } });
  await loop.processDelivery({ messages: [{ ...done, payload: '{"dispatchId":"d1","outcome":"failed"}' }] });
  const text = slack.chat.postMessage.mock.calls.map(([m]) => m.text).join('\n');
  expect(text).toContain('line10'); expect(text).not.toContain('line9'); expect(text).not.toContain('⠋');
  expect(orca.call).toHaveBeenCalledWith('worker-read', ['--dispatch', 'd1', '--source', 'terminal']);
  expect(orca.call).toHaveBeenCalledWith('worker-release', ['--dispatch', 'd1']);
  expect(store.byDispatch('d1')?.status).toBe('failed');
});
it('stores questions and sends unknown dispatch reports to ops without releasing', async () => {
  const { loop, store, slack, orca } = setup();
  await loop.processDelivery({ messages: [
    { id: 'q1', type: 'question', body: 'Choose', payload: '{"dispatchId":"d1","options":["yes"]}' },
    { ...done, payload: '{"dispatchId":"unknown","outcome":"succeeded"}' },
  ] });
  expect(store.pendingQuestion('1.1')).toMatchObject({ message_id: 'q1', options_json: '["yes"]' });
  expect(slack.chat.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'COPS' }));
  expect(orca.call).not.toHaveBeenCalled();
});
it('does not ack on a post failure and waits five seconds before replay', async () => {
  vi.useFakeTimers();
  const { loop, slack, orca, log } = setup();
  const controller = new AbortController();
  slack.chat.postMessage.mockRejectedValueOnce(new Error('offline'));
  orca.call.mockImplementation(async (verb: string, args: string[]) => {
    if (verb === 'check' && args.includes('--ack')) { controller.abort(); return { messages: [] }; }
    return verb === 'check' ? { deliveryId: 'del1', messages: [done] } : {};
  });
  const running = loop.run(controller.signal);
  await vi.advanceTimersByTimeAsync(4999);
  expect(orca.call).toHaveBeenCalledTimes(1); expect(log).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await running;
  expect(slack.chat.postMessage).toHaveBeenCalledTimes(2);
});
it('processes deliveries returned by ack without dropping them', async () => {
  const { loop, orca, slack } = setup();
  const controller = new AbortController(); let checks = 0;
  orca.call.mockImplementation(async (verb: string) => {
    if (verb !== 'check') return {};
    checks++;
    if (checks === 3) { controller.abort(); return { messages: [] }; }
    return { deliveryId: `del${checks}`, messages: [{ id: `m${checks}`, type: 'merge_ready', body: 'PR ready', payload: '{"dispatchId":"d1"}' }] };
  });
  await loop.run(controller.signal);
  expect(slack.chat.postMessage).toHaveBeenCalledTimes(2);
});
it('preserves stopped status when a late completion arrives', async () => {
  const { loop, store, orca } = setup(); store.setStatus('1.1', 'stopped');
  await loop.processDelivery({ messages: [done] });
  expect(store.byDispatch('d1')?.status).toBe('stopped'); expect(orca.call).not.toHaveBeenCalled();
});
it('renders already answered questions inert when a delivery replays', async () => {
  const { loop, store, slack } = setup();
  store.saveQuestion('q1', '1.1', ['yes'], '2.2'); store.answerQuestion('q1', 'U1');
  await loop.processDelivery({ messages: [{ id: 'q1', type: 'question', body: 'Choose', payload: '{"dispatchId":"d1","options":["yes"]}' }] });
  expect(slack.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ blocks: [], text: 'U1 answered this question.' }));
  expect(store.pendingQuestion('1.1')).toBeUndefined();
});
it('reports an escalation without releasing the still-live worker', async () => {
  const { loop, orca, slack, store } = setup();
  orca.call.mockRejectedValueOnce(new Error('No terminal'));
  await loop.processDelivery({ messages: [{ ...done, type: 'escalation' }] });
  expect(slack.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('终端输出不可用') }));
  expect(slack.reactions.add).toHaveBeenCalledWith(expect.objectContaining({ name: 'x' }));
  expect(orca.call.mock.calls.map(([verb]) => verb)).toEqual(['worker-read']);
  expect(store.byDispatch('d1')?.status).toBe('running');
});
it('acks a delivery even when worker-release fails', async () => {
  const { loop, orca, store } = setup();
  orca.call.mockRejectedValueOnce(new Error('release refused'));
  await expect(loop.processDelivery({ messages: [done] })).resolves.toBeUndefined();
  expect(store.byDispatch('d1')?.status).toBe('done');
});
it('does not post a fabricated success for a completion without an explicit outcome', async () => {
  const { loop, slack, store, orca } = setup();
  await expect(loop.processDelivery({ messages: [{ ...done, payload: '{"dispatchId":"d1"}' }] })).rejects.toThrow('outcome');
  expect(slack.chat.postMessage).not.toHaveBeenCalled(); expect(orca.call).not.toHaveBeenCalled();
  expect(store.byDispatch('d1')?.status).toBe('running');
});
it('settles and releases a late successful report after an uncertain start or escalation', async () => {
  const { loop, store, orca } = setup(); store.setStatus('1.1', 'failed');
  await loop.processDelivery({ messages: [done] });
  expect(store.byDispatch('d1')?.status).toBe('done');
  expect(orca.call).toHaveBeenCalledWith('worker-release', ['--dispatch', 'd1']);
});
