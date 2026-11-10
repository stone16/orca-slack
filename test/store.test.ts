import { DatabaseSync } from 'node:sqlite';
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

test.each([
  ['legacy-pr', 'https://github.com/example/web/pull/12'],
  ['https://github.com/example/web/pull/12', 'new-pr'],
])('a PR URL cannot be observed under another worktree regardless of its saved id (%s)', (savedId, observedId) => {
  const store = new Store(':memory:');
  try {
    store.saveThread({ id: 'thread', channel: 'C1', threadTs: '1', owner: 'U1' });
    store.saveWorktree({ id: 'first', threadId: 'thread', repository: 'example/web', branch: 'feat/first' });
    store.saveWorktree({ id: 'second', threadId: 'thread', repository: 'example/web', branch: 'feat/second' });
    const url = 'https://github.com/example/web/pull/12';
    store.savePullRequest({ id: savedId, worktreeId: 'first', url });
    expect(() => store.observePullRequests([{ id: observedId, worktreeId: 'second', url,
      number: 12, state: 'MERGED', headRefOid: 'a'.repeat(40) }])).toThrow('Pull request belongs to another worktree');
    expect(store.pullRequests('thread')).toEqual([{ id: savedId, worktreeId: 'first', url }]);
    expect(store.observedPullRequests('thread')).toEqual([]);
  } finally { store.close(); }
});

test('saving a PR link cannot give the same URL to another worktree under a new id', () => {
  const store = new Store(':memory:');
  try {
    store.saveThread({ id: 'thread', channel: 'C1', threadTs: '1', owner: 'U1' });
    store.saveWorktree({ id: 'first', threadId: 'thread', repository: 'example/web', branch: 'feat/first' });
    store.saveWorktree({ id: 'second', threadId: 'thread', repository: 'example/web', branch: 'feat/second' });
    const url = 'https://github.com/example/web/pull/12';
    store.savePullRequest({ id: 'legacy-pr', worktreeId: 'first', url });
    expect(() => store.savePullRequest({ id: 'duplicate', worktreeId: 'second', url })).toThrow(/UNIQUE/);
    expect(store.pullRequests('thread')).toEqual([{ id: 'legacy-pr', worktreeId: 'first', url }]);
  } finally { store.close(); }
});

test('B1 launch cutoffs preserve legacy rows and the original launch table shape', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-legacy-launch-')); roots.push(root);
  const file = join(root, 'ledger.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, channel TEXT NOT NULL, threadTs TEXT NOT NULL,
      owner TEXT NOT NULL, linearTicket TEXT, UNIQUE(channel, threadTs));
    CREATE TABLE lead_launches (threadId TEXT PRIMARY KEY REFERENCES threads(id), id TEXT NOT NULL, dispatchId TEXT);
    INSERT INTO threads VALUES ('thread', 'C1', '1', 'owner', NULL);
    INSERT INTO lead_launches VALUES ('thread', 'legacy-launch', 'legacy-dispatch');`);
  legacy.close();
  let store = new Store(file);
  try {
    expect(store.pendingLaunch('thread')).toBe('legacy-launch');
    expect(store.launchDispatch('thread')).toBe('legacy-dispatch');
    const thread = store.thread('thread')!;
    for (const ts of ['1', '2']) store.saveInbound(thread, { installationId: 'app', eventId: ts, channel: 'C1', ts,
      user: 'owner', text: `Prompt ${ts}` }, 'prompt');
    expect(store.launchPromptKeys('thread')).toEqual([]);
    expect(store.inbound('thread').map(message => message.state)).toEqual(['pending', 'pending']);
    store.finishLeadLaunch('thread');
    const oldWriter = new DatabaseSync(file);
    try { expect(() => oldWriter.prepare('INSERT INTO lead_launches VALUES (?, ?, NULL)').run('thread', 'next-launch')).not.toThrow(); }
    finally { oldWriter.close(); }
    const firstKey = store.inbound('thread')[0].key;
    store.saveLaunchPrompt('thread', firstKey);
    store.close(); store = new Store(file);
    expect(store.launchPromptKeys('thread')).toEqual([firstKey]);
    store.finishLeadLaunch('thread'); store.beginLeadLaunch('thread', 'fresh-launch');
    expect(store.launchPromptKeys('thread')).toEqual([]);
  } finally { store.close(); }
});
