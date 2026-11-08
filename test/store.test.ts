import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../src/store.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });

test('one thread retains two repositories, their pull requests, and replacement lead history after reopening', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-ledger-'));
  roots.push(root);
  const file = join(root, 'ledger.sqlite');
  let store = new Store(file);
  store.saveThread({ id: 'thread', channel: 'C1', threadTs: '1.0', owner: 'U1', linearTicket: 'ENG-1' });
  store.saveWorktree({ id: 'web-tree', threadId: 'thread', repository: 'example/web', branch: 'feat/export' });
  store.saveWorktree({ id: 'api-tree', threadId: 'thread', repository: 'example/api', branch: 'feat/export-api' });
  store.savePullRequest({ id: 'web-pr', worktreeId: 'web-tree', url: 'https://github.com/example/web/pull/1' });
  store.savePullRequest({ id: 'api-pr', worktreeId: 'api-tree', url: 'https://github.com/example/api/pull/2' });
  store.replaceLead({ id: 'session-1', threadId: 'thread', worktreeId: 'web-tree', runId: 'run-1',
    taskId: 'task-1', dispatchId: 'dispatch-1', handle: 'handle-1' });
  store.replaceLead({ id: 'session-2', threadId: 'thread', worktreeId: 'web-tree', runId: 'run-1',
    taskId: 'task-2', dispatchId: 'dispatch-2', handle: 'handle-2' });
  store.close();
  store = new Store(file);
  try {
    expect(store.thread('thread')).toEqual({ id: 'thread', channel: 'C1', threadTs: '1.0', owner: 'U1', linearTicket: 'ENG-1' });
    expect(store.worktrees('thread')).toEqual([
      { id: 'web-tree', threadId: 'thread', repository: 'example/web', branch: 'feat/export' },
      { id: 'api-tree', threadId: 'thread', repository: 'example/api', branch: 'feat/export-api' },
    ]);
    expect(store.pullRequests('thread').map(pr => pr.url)).toEqual([
      'https://github.com/example/web/pull/1', 'https://github.com/example/api/pull/2',
    ]);
    expect(store.leadSessions('thread').map(session => [session.id, session.active])).toEqual([
      ['session-1', false], ['session-2', true],
    ]);
  } finally { store.close(); }
});

test('a failed replacement cannot steal another thread worktree or retire the current lead', () => {
  const store = new Store(':memory:');
  try {
    store.saveThread({ id: 'a', channel: 'C1', threadTs: '1', owner: 'U1' });
    store.saveThread({ id: 'b', channel: 'C1', threadTs: '2', owner: 'U2' });
    store.saveWorktree({ id: 'tree-a', threadId: 'a', repository: 'example/a', branch: 'feat/a' });
    store.saveWorktree({ id: 'tree-b', threadId: 'b', repository: 'example/b', branch: 'feat/b' });
    store.replaceLead({ id: 'first', threadId: 'a', worktreeId: 'tree-a', runId: 'run', taskId: 'task-a', dispatchId: 'dispatch-a', handle: 'handle-a' });
    expect(() => store.replaceLead({ id: 'invalid', threadId: 'a', worktreeId: 'tree-b', runId: 'run',
      taskId: 'task-b', dispatchId: 'dispatch-b', handle: 'handle-b' })).toThrow();
    expect(store.leadSessions('a').map(session => [session.id, session.active])).toEqual([['first', true]]);
  } finally { store.close(); }
});

test('decision options and the answering user survive reopening and cannot be answered twice', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-decision-'));
  roots.push(root);
  const file = join(root, 'ledger.sqlite');
  let store = new Store(file);
  store.saveThread({ id: 'thread', channel: 'C1', threadTs: '1', owner: 'U1' });
  store.saveDecision({ id: 'question', threadId: 'thread', options: ['continue', 'pause'], slackTs: '2' });
  expect(store.answerDecision('question', 'continue', 'U1')).toBe(true);
  expect(store.answerDecision('question', 'pause', 'U1')).toBe(false);
  store.close();
  store = new Store(file);
  try {
    expect(store.decision('question')).toEqual({ id: 'question', threadId: 'thread', options: ['continue', 'pause'],
      slackTs: '2', answer: 'continue', answeredBy: 'U1' });
  } finally { store.close(); }
});
