import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Bridge } from '../src/slack.js';
import { ReportLoop } from '../src/report-loop.js';
import { Store } from '../src/store.js';
import { ensureRun } from '../src/main.js';
import { config, fakeSlack } from './helpers.js';
it('dispatches, restarts, answers a question, forwards a follow-up and completes in the same Slack thread', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'orca-flow-')), 'state.sqlite');
  const slack = fakeSlack();
  const orca = { call: vi.fn().mockImplementation(async (verb: string) => {
    if (verb === 'run-create') return { run: { id: 'r1' } };
    if (verb === 'worker-start') return { dispatchId: 'd1', taskId: 't1', runId: 'r1', effects: [{ kind: 'worktree', id: 'repo::/tmp/task' }] };
    return {};
  }) };
  let store = new Store(file);
  const runId = await ensureRun(orca, store, 'test');
  let bridge = new Bridge(orca, slack.client, store, config, runId);
  const event = { channel: 'C1', user: 'U1', botId: 'UBOT', mention: true, ts: '1.1', eventId: 'e1', text: '<@UBOT> ship it' };
  await bridge.event(event); store.close();
  store = new Store(file);
  expect(await ensureRun(orca, store, 'test')).toBe(runId);
  bridge = new Bridge(orca, slack.client, store, config, runId);
  await bridge.event(event);
  const loop = new ReportLoop(orca, slack.client, store, config, runId, vi.fn(), vi.fn());
  await loop.processDelivery({ messages: [{ id: 'q1', type: 'question', body: 'Choose', payload: '{"dispatchId":"d1","options":["yes","no"]}' }] });
  await bridge.action({ actionId: 'answer', value: '{"messageId":"q1","option":"yes"}', user: 'U1', channel: 'C1', messageTs: '2.2' });
  await bridge.event({ ...event, eventId: 'e2', ts: '3.3', threadTs: '1.1', text: 'include docs', mention: false });
  await loop.processDelivery({ messages: [
    { id: 'm1', type: 'merge_ready', body: 'https://github.com/example/repo/pull/1', payload: '{"dispatchId":"d1"}' },
    { id: 'm2', type: 'worker_done', body: 'Shipped. Checks passed. Ready.', payload: '{"dispatchId":"d1","outcome":"succeeded","reportPath":"/tmp/report"}' },
  ] });
  expect(orca.call.mock.calls.map(([verb]) => verb)).toEqual(['run-create', 'worker-start', 'reply', 'send', 'worker-release']);
  expect(store.byDispatch('d1')).toMatchObject({ status: 'done', worktree: '/tmp/task' });
  expect(slack.chat.postMessage.mock.calls.every(([m]) => m.channel === 'C1' && m.thread_ts === '1.1')).toBe(true);
  expect(JSON.stringify(slack.chat.postMessage.mock.calls)).toContain('https://github.com/example/repo/pull/1');
  store.close();
});
