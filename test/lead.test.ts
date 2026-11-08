import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { LeadCli } from '../src/lead-orca.js';
import { Leads } from '../src/leads.js';
import { Bridge } from '../src/slack.js';
import { ReportLoop } from '../src/report-loop.js';
import { Store, type Report, type SlackEvent } from '../src/store.js';

const stores: Store[] = [];
const roots: string[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true })); });
const repositories = [{ id: 'repo-web', name: 'web', aliases: ['frontend'] }, { id: 'repo-api', name: 'api', aliases: ['backend'] }];
const slack = { refuse: async () => {}, ownerAction: async () => {} };
const event: SlackEvent = { installationId: 'app', eventId: 'first', channel: 'channel', ts: '1', user: 'owner', text: '<@BOT> Fix web password errors to show a specific reason' };
function setup(file = ':memory:') {
  const store = new Store(file);
  stores.push(store);
  const commands: string[][] = [];
  let starts = 0;
  let failure: string | undefined;
  let changeSource = false;
  let partialLaunch = false;
  let state = { projection: { liveness: { verdict: 'live' }, attention: { requiresAction: false } }, observation: { agentWait: null as unknown } };
  let read = { source: 'transcript', cursor: 'w1' };
  let terminal = { status: 'running', source: 'stream', nextCursor: 't1' };
  const reports: Report[] = [];
  const orca = new LeadCli(async args => {
    commands.push(args);
    if (args[1] === 'worker-read' && changeSource) {
      changeSource = false;
      return { stdout: '{"ok":false,"error":{"code":"source_changed","message":"Cursor source differs"}}' };
    }
    if (args[1] === 'worker-start' && partialLaunch) return { stdout: '{"ok":false,"result":{"dispatchId":"partial-dispatch","taskId":"partial-task","failedStage":"launch","lastError":"uncertain command"}}' };
    if (args[1] === failure) return { stdout: '{"ok":false,"error":{"message":"uncertain command"}}' };
    let result: unknown = {};
    if (args[0] === 'worktree') result = { worktree: { id: 'tree-1', branch: 'refs/heads/feat/thread' } };
    else if (args[1] === 'worker-start') result = { dispatchId: `dispatch-${++starts}`, taskId: `task-${starts}`, runId: 'run', effects: [{ kind: 'terminal', role: 'agent', id: `handle-${starts}` }] };
    else if (args[1] === 'worker-show') result = state;
    else if (args[1] === 'worker-read') result = read;
    else if (args[0] === 'terminal') result = terminal;
    else if (args[1] === 'inbox') result = { count: reports.length, messages: reports };
    return { stdout: JSON.stringify({ ok: true, result }) };
  });
  const leads = new Leads(orca, store, { runId: 'run', repositories, botId: 'BOT', agent: 'codex' });
  const bridge = new Bridge(orca, slack, store, ['owner', 'peer'], 'BOT', undefined, leads);
  return { store, orca, leads, bridge, commands, reports,
    partialLaunch: () => { partialLaunch = true; },
    sourceChange: () => { changeSource = true; },
    noWaitEvidence: () => { state.observation.agentWait = undefined; },
    fail: (verb: string | undefined) => { failure = verb; },
    unknown: () => { state = { projection: { liveness: { verdict: 'unverifiable' }, attention: { requiresAction: true } }, observation: { agentWait: null } }; },
    wait: () => { state.observation.agentWait = { reason: 'human prompt' }; },
    read: (source: string, cursor: string) => { read = { source, cursor }; },
    terminal: (status: string, cursor = 't1', source = 'stream') => { terminal = { status, source, nextCursor: cursor }; },
  };
}
const threadId = JSON.stringify(['channel', '1']);
function report(type: string, payload: Record<string, unknown> = {}, body = 'Report', id = 'report-1'): Report {
  return { id, runId: 'run', state: 'pending', sequence: 1, type, body,
    payload: JSON.stringify({ dispatchId: 'dispatch-1', taskId: 'task-1', ...payload }) };
}
const calls = (commands: string[][], verb: string) => commands.filter(args => args[1] === verb);
const argument = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test.each([
  ['question', '<@BOT> Where is the web session timeout configured?', 'repo-web'],
  ['clarify', '<@BOT> I want a web export feature', 'repo-web'],
  ['implement', event.text, 'repo-web'],
  ['clarify', '<@BOT> I want an export feature', undefined],
] as const)('classifies %s once and saves its routing sample for %s', async (intent, text, repository) => {
  const { bridge, store } = setup();
  await bridge.event({ ...event, text });
  await bridge.event({ ...event, eventId: 'second', ts: '2', threadTs: '1', text: '<@BOT> Change api instead' });
  expect(store.routingSamples(threadId)).toEqual([{ threadId, text, intent, repository: repository ?? null, rule: repository ? 'alias' : 'unknown-repository' }]);
  if (!repository) expect(store.leadSessions(threadId)).toEqual([]);
});

test('starts a Bridge-coordinated lead on a new worktree with all forwarded text and no archived text', async () => {
  const { bridge, store, commands } = setup();
  store.saveThread({ id: threadId, channel: 'channel', threadTs: '1', owner: 'owner', linearTicket: 'ENG-1' });
  store.saveInbound(store.thread(threadId)!, event, 'prompt');
  store.saveInbound(store.thread(threadId)!, { ...event, eventId: 'archive', ts: '2', user: 'peer', text: 'SECRET_ARCHIVE' }, 'archive');
  store.saveInbound(store.thread(threadId)!, { ...event, eventId: 'later', ts: '3', text: 'Include CSV and monthly filtering' }, 'prompt');
  await bridge.replay();
  const create = calls(commands, 'create')[0];
  expect(create.slice(0, 2)).toEqual(['worktree', 'create']);
  expect(argument(create, '--repo')).toBe('id:repo-web');
  expect(create).toContain('--no-parent');
  const start = calls(commands, 'worker-start')[0];
  expect(argument(start, '--run')).toBe('run');
  expect(argument(start, '--worktree')).toBe('id:tree-1');
  expect(argument(start, '--agent')).toBe('codex');
  expect(start).not.toContain('--keep-open');
  const prompt = argument(start, '--spec');
  for (const text of [event.text, 'Include CSV and monthly filtering', 'ENG-1', 'Bridge is the only Run coordinator', 'Do not run run-create, worker-start, dispatch', 'CHILD_REQUEST', 'orca orchestration ask']) expect(prompt).toContain(text);
  expect(prompt).not.toContain('SECRET_ARCHIVE');
  expect(store.inbound(threadId).map(row => row.state)).toEqual(['forwarded', 'archived', 'forwarded']);
  expect(calls(commands, 'send')).toHaveLength(0);
});

test('a completed session is replaced on the same worktree with lead history and full forwarded thread', async () => {
  const { bridge, leads, store, commands } = setup();
  await bridge.event(event);
  await leads.report(report('worker_done', { outcome: 'succeeded' }));
  await bridge.event({ ...event, eventId: 'next', ts: '2', threadTs: '1', text: 'Use Chinese copy too' });
  expect(calls(commands, 'create')).toHaveLength(1);
  const starts = calls(commands, 'worker-start');
  expect(starts).toHaveLength(2);
  expect(argument(starts[1], '--worktree')).toBe('id:tree-1');
  expect(argument(starts[1], '--spec')).toContain(event.text);
  expect(argument(starts[1], '--spec')).toContain('Use Chinese copy too');
  expect(argument(starts[1], '--spec')).toContain('dispatch-1');
  expect(store.leadSessions(threadId).map(row => [row.dispatchId, row.active])).toEqual([['dispatch-1', false], ['dispatch-2', true]]);
});

test('a question report saves one decision, owner answer replies once, and duplicate reports stay idempotent', async () => {
  const { bridge, leads, store, commands } = setup();
  await bridge.event(event);
  const question = report('question', {}, JSON.stringify({ question: 'Which records?', options: ['orders', 'users'] }), 'question');
  await leads.report(question);
  await leads.report(question);
  expect(store.decision('question')).toMatchObject({ threadId, options: ['orders', 'users'] });
  expect(store.leadEvents(threadId).filter(row => row.kind === 'waiting')).toHaveLength(1);
  const action = { actionId: 'decision' as const, threadId, channel: 'channel', user: 'owner', decisionId: 'question', option: 'orders' };
  expect(await bridge.action({ ...action, user: 'peer' })).toBe(false);
  expect(await bridge.action({ ...action, option: 'invalid' })).toBe(false);
  expect(await bridge.action(action)).toBe(true);
  expect(await bridge.action(action)).toBe(false);
  expect(calls(commands, 'reply')).toEqual([['orchestration', 'reply', '--id', 'question', '--body', 'orders', '--run', 'run', '--json', '--full']]);
  expect(store.decision('question')).toMatchObject({ answer: 'orders', answeredBy: 'owner' });
});

test('plain Orca questions accept an owner thread reply without forwarding it as a new prompt', async () => {
  const { bridge, leads, store, commands } = setup();
  await bridge.event(event);
  await leads.report(report('question', {}, 'Which records?', 'question'));
  await bridge.event({ ...event, ts: '2', eventId: 'answer', threadTs: '1', text: 'orders' });
  expect(calls(commands, 'reply')).toHaveLength(1);
  expect(calls(commands, 'send')).toHaveLength(0);
  expect(store.decision('question')?.answer).toBe('orders');
});

test('failure reports become failed events while late reports cannot end the replacement lead', async () => {
  const { bridge, leads, store } = setup();
  await bridge.event(event);
  await leads.report(report('worker_done', { outcome: 'failed' }, 'Port is occupied'));
  expect(store.leadEvents(threadId).at(-1)).toMatchObject({ kind: 'failed', text: 'Port is occupied' });
  expect(store.leadSessions(threadId)[0].active).toBe(false);
  await bridge.event({ ...event, eventId: 'next', ts: '2', threadTs: '1' });
  await leads.report(report('worker_done', { outcome: 'failed' }, 'Duplicate', 'late-report'));
  expect(store.leadSessions(threadId)[1].active).toBe(true);
});

test('stop records a stopped event and leaves the worktree in place', async () => {
  const { bridge, store, commands } = setup();
  await bridge.event(event);
  await bridge.event({ ...event, eventId: 'stop', ts: '2', threadTs: '1', user: 'peer', text: '!stop' });
  expect(store.leadEvents(threadId).at(-1)?.kind).toBe('stopped');
  expect(store.worktrees(threadId)).toHaveLength(1);
  expect(store.leadSessions(threadId)[0].active).toBe(false);
  expect(calls(commands, 'worker-stop')).toHaveLength(1);
  expect(calls(commands, 'rm')).toHaveLength(0);
});

test('unverifiable status is unknown before two frozen polls and interrupted only past the grace window', async () => {
  const h = setup();
  await h.bridge.event(event);
  h.unknown();
  await h.leads.poll();
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('unknown');
  await h.leads.poll();
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('unknown');
  await h.leads.poll();
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('interrupted');
  await h.bridge.event({ ...event, eventId: 'next', ts: '2', threadTs: '1' });
  expect(calls(h.commands, 'worker-start')).toHaveLength(1);
  expect(calls(h.commands, 'send')).toHaveLength(0);
});

test.each(['worker source', 'worker cursor', 'terminal source', 'terminal cursor', 'human wait'])('%s evidence resets the interruption baseline', async change => {
  const h = setup();
  await h.bridge.event(event);
  h.unknown();
  await h.leads.poll();
  await h.leads.poll();
  if (change === 'worker source') h.read('terminal', 'w1');
  if (change === 'worker cursor') h.read('transcript', 'w2');
  if (change === 'terminal source') h.terminal('running', 't1', 'archive');
  if (change === 'terminal cursor') h.terminal('running', 't2');
  if (change === 'human wait') h.wait();
  await h.leads.poll();
  expect(h.store.leadEvents(threadId).at(-1)?.kind).not.toBe('interrupted');
});

test('an exited terminal becomes interrupted without starting a replacement', async () => {
  const h = setup();
  await h.bridge.event(event);
  h.terminal('exited');
  await h.leads.poll();
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('interrupted');
  expect(calls(h.commands, 'worker-start')).toHaveLength(1);
});

test('a correlated finished-without-report escalation becomes interrupted', async () => {
  const h = setup();
  await h.bridge.event(event);
  await h.leads.report(report('escalation', { stopReason: 'finished' }));
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('interrupted');
});

test('restart resumes ledger leads and pending decisions without starting a second session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-leads-'));
  roots.push(root);
  const file = join(root, 'ledger.sqlite');
  const first = setup(file);
  await first.bridge.event(event);
  await first.leads.report(report('question', {}, 'Which records?', 'question'));
  first.store.close();
  stores.splice(stores.indexOf(first.store), 1);
  const second = setup(file);
  await second.bridge.replay();
  await second.leads.poll();
  await second.bridge.event({ ...event, eventId: 'answer', ts: '2', threadTs: '1', text: 'orders' });
  expect(calls(second.commands, 'worker-start')).toHaveLength(0);
  expect(calls(second.commands, 'reply')).toHaveLength(1);
  expect(second.store.leadSessions(threadId)).toHaveLength(1);
});

test('a launch with uncertain effects stays unknown across replay instead of creating a second session', async () => {
  const h = setup();
  h.fail('worker-start');
  await expect(h.bridge.event(event)).rejects.toThrow('uncertain command');
  h.fail(undefined);
  await h.bridge.replay();
  expect(calls(h.commands, 'worker-start')).toHaveLength(1);
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('unknown');
});

test('the single report loop recovers a question and completion into durable lead events', async () => {
  const h = setup();
  await h.bridge.event(event);
  h.reports.push(report('question', {}, 'Which records?', 'question'));
  const loop = new ReportLoop(h.orca, h.store, 'run', report => h.leads.report(report));
  await loop.recover();
  await loop.recover();
  expect(h.store.leadEvents(threadId).filter(row => row.kind === 'waiting')).toHaveLength(1);
  expect(h.store.reports('run')[0].state).toBe('sent');
});

test('a failed observation resets the frozen evidence window', async () => {
  const h = setup();
  await h.bridge.event(event);
  h.unknown();
  await h.leads.poll();
  await h.leads.poll();
  h.fail('worker-read');
  await h.leads.poll();
  h.fail(undefined);
  await h.leads.poll();
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('unknown');
});

test('a known pending question prevents frozen reads from declaring interruption', async () => {
  const h = setup();
  await h.bridge.event(event);
  await h.leads.report(report('question', {}, 'Which records?', 'question'));
  h.unknown();
  for (let n = 0; n < 4; n++) await h.leads.poll();
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('waiting');
});

test('failed stop retains the active lead and never records a successful stop', async () => {
  const h = setup();
  await h.bridge.event(event);
  h.fail('worker-stop');
  await expect(h.bridge.event({ ...event, eventId: 'stop', ts: '2', threadTs: '1', text: '!stop' })).rejects.toThrow('uncertain command');
  expect(h.store.leadSessions(threadId)[0].active).toBe(true);
  expect(h.store.leadEvents(threadId).some(row => row.kind === 'stopped')).toBe(false);
});

test('a failed reply leaves the saved decision unanswered', async () => {
  const h = setup();
  await h.bridge.event(event);
  await h.leads.report(report('question', {}, 'Which records?', 'question'));
  h.fail('reply');
  await expect(h.leads.answer(threadId, 'question', 'orders', 'owner')).rejects.toThrow('uncertain command');
  expect(h.store.decision('question')?.answer).toBeUndefined();
});

test('concurrent initial messages create one lead and forward the later message once', async () => {
  const h = setup();
  await Promise.all([h.bridge.event(event), h.bridge.event({ ...event, eventId: 'next', ts: '2', threadTs: '1', text: 'Also export orders' })]);
  expect(calls(h.commands, 'worker-start')).toHaveLength(1);
  expect(h.store.inbound(threadId).filter(row => row.state === 'forwarded')).toHaveLength(2);
});

test('malformed and cross-Run reports cannot create a decision or settle a lead', async () => {
  const h = setup();
  await h.bridge.event(event);
  await h.leads.report({ ...report('worker_done', { outcome: 'succeeded' }), runId: 'other-run' });
  await h.leads.report({ ...report('question'), payload: 'invalid JSON' });
  await h.leads.report(report('question', { taskId: 'other-task' }));
  expect(h.store.leadSessions(threadId)[0].active).toBe(true);
  expect(h.store.pendingLeadDecisions(threadId)).toEqual([]);
});

test('a worker cursor source_changed response retries a fresh read and resets its baseline', async () => {
  const h = setup();
  await h.bridge.event(event);
  h.unknown();
  await h.leads.poll();
  await h.leads.poll();
  h.sourceChange();
  h.read('terminal', 'w2');
  await h.leads.poll();
  expect(calls(h.commands, 'worker-read').at(-1)).not.toContain('--cursor');
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('unknown');
});

test('missing human-wait evidence never proves a stalled assignment is interrupted', async () => {
  const h = setup();
  await h.bridge.event(event);
  h.unknown();
  h.noWaitEvidence();
  for (let n = 0; n < 4; n++) await h.leads.poll();
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('unknown');
});

test('stop cancels the exact partial launch Dispatch retained in the ledger', async () => {
  const h = setup();
  h.partialLaunch();
  await expect(h.bridge.event(event)).rejects.toThrow('uncertain command');
  await h.bridge.event({ ...event, eventId: 'stop', ts: '2', threadTs: '1', text: '!stop' });
  expect(calls(h.commands, 'worker-stop')).toEqual([['orchestration', 'worker-stop', '--dispatch', 'partial-dispatch', '--json', '--full']]);
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('stopped');
  expect(h.store.worktrees(threadId)).toHaveLength(1);
});

test('the measured live projection remains running even with unchanged read cursors', async () => {
  const h = setup();
  await h.bridge.event(event);
  for (let n = 0; n < 4; n++) await h.leads.poll();
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('running');
});

test('source_changed resets frozen evidence even when source labels and cursor values match', async () => {
  const h = setup();
  await h.bridge.event(event);
  h.unknown();
  await h.leads.poll();
  await h.leads.poll();
  h.sourceChange();
  await h.leads.poll();
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('unknown');
});
