import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Store } from '../src/store.js';
export const thread = { thread_ts: '1.1', channel: 'C1', run_id: 'r1', task_id: 't1', dispatch_id: 'd1', worktree: '/tmp/work', repo: 'name:repo', requester: 'U1', status: 'running' };
it('persists threads, questions, event deduplication and the run across restarts', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'orca-slack-')), 'state.sqlite');
  let store = new Store(path);
  store.saveThread(thread);
  store.setMeta('run_id', 'r1');
  expect(store.claim('event1')).toBe(true);
  expect(store.claim('event1')).toBe(false);
  store.saveQuestion('m1', '1.1', ['yes'], '2.2');
  store.close();
  store = new Store(path);
  expect(store.byDispatch('d1')).toMatchObject(thread);
  expect(store.getMeta('run_id')).toBe('r1');
  expect(store.claim('event1')).toBe(false);
  expect(store.pendingQuestion('1.1')?.message_id).toBe('m1');
  store.answerQuestion('m1', 'U1');
  expect(store.pendingQuestion('1.1')).toBeUndefined();
  expect(store.question('m1')?.answered_by).toBe('U1');
  store.setStatus('1.1', 'done');
  expect(store.byThread('1.1')?.status).toBe('done');
  store.close();
});

it('enforces dispatch message uniqueness by channel and message timestamp', () => {
  const store = new Store(':memory:');
  store.saveThread({ ...thread, ts: 'dispatch-ts' });
  expect(() => store.saveThread({ ...thread, thread_ts: 'other-root', dispatch_id: 'd2', ts: 'dispatch-ts' })).toThrow(/UNIQUE/);
  store.close();
});
