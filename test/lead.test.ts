import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { LeadCli } from '../src/lead-orca.js';
import { Leads } from '../src/leads.js';
import { Bridge } from '../src/slack.js';
import { ReportLoop } from '../src/report-loop.js';
import { Store, type Report, type SlackEvent } from '../src/store.js';

const stores: Store[] = [];
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true })); });
const repositories = [{ id: 'repo-web', name: 'web', aliases: ['frontend'] }, { id: 'repo-api', name: 'api', aliases: ['backend'] }];
const slack = { refuse: async () => {}, ownerAction: async () => {} };
const event: SlackEvent = { installationId: 'app', eventId: 'first', channel: 'channel', ts: '1', user: 'owner', text: '<@BOT> Fix web password errors to show a specific reason' };
function setup(file = ':memory:') {
  const store = new Store(file);
  stores.push(store);
  const commands: string[][] = [];
  let starts = 0;
  let workerLists: Record<string, unknown> = { '': { workers: [], page: { hasMore: false, nextCursor: null } } };
  let failure: string | undefined;
  let changeSource = false;
  let partialLaunch = false;
  let blocked: { verb: string; entered: () => void; wait: Promise<void> } | undefined;
  let state = { projection: { liveness: { verdict: 'live', source: 'agent_status' }, attention: { categories: [] as string[], requiresAction: false } }, observation: { status: 'live', exactWorker: true, agentWait: null as unknown } };
  let read = { source: 'transcript', cursor: 'w1' };
  let terminal = { status: 'running', source: 'stream', nextCursor: 't1' };
  const reports: Report[] = [];
  const orca = new LeadCli(async args => {
    commands.push(args);
    if (blocked?.verb === args[1]) {
      const current = blocked;
      blocked = undefined;
      current.entered();
      await current.wait;
    }
    if (args[1] === 'worker-read' && changeSource) {
      changeSource = false;
      return { stdout: '{"ok":false,"error":{"code":"source_changed","message":"Cursor source differs"}}' };
    }
    if (args[1] === 'worker-start' && partialLaunch) return { stdout: '{"ok":false,"result":{"dispatchId":"partial-dispatch","taskId":"partial-task","failedStage":"launch","lastError":"uncertain command"}}' };
    if (args[1] === failure) return { stdout: '{"ok":false,"error":{"message":"uncertain command"}}' };
    let result: unknown = {};
    if (args[0] === 'worktree') result = { worktree: { id: 'tree-1', branch: 'refs/heads/feat/thread' } };
    else if (args[1] === 'worker-start') result = { dispatchId: `dispatch-${++starts}`, taskId: `task-${starts}`, runId: 'run', effects: [{ kind: 'terminal', role: 'agent', id: `handle-${starts}` }] };
    else if (args[1] === 'worker-list') result = workerLists[args.includes('--cursor') ? args[args.indexOf('--cursor') + 1] : ''];
    else if (args[1] === 'worker-show') result = state;
    else if (args[1] === 'worker-read') result = read;
    else if (args[0] === 'terminal') result = terminal;
    else if (args[1] === 'inbox') result = { count: reports.length, messages: reports };
    return { stdout: JSON.stringify({ ok: true, result }) };
  });
  const leads = new Leads(orca, store, { runId: 'run', repositories, botId: 'BOT', agent: 'codex' });
  const bridge = new Bridge(orca, slack, store, ['owner', 'peer'], 'BOT', undefined, leads);
  return { store, orca, leads, bridge, commands, reports,
    workerLists: (pages: Record<string, unknown>) => { workerLists = pages; },
    block: (verb: string) => {
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      blocked = { verb, entered, wait };
      return { ready, release };
    },
    partialLaunch: () => { partialLaunch = true; },
    sourceChange: () => { changeSource = true; },
    noWaitEvidence: () => { state.observation.agentWait = undefined; },
    fail: (verb: string | undefined) => { failure = verb; },
    liveness: (verdict: string) => { state.projection.liveness.verdict = verdict; },
    unknown: () => { state = { projection: { liveness: { verdict: 'unverifiable', source: 'agent_status' }, attention: { categories: ['unverifiable'], requiresAction: true } }, observation: { status: 'live', exactWorker: true, agentWait: null } }; },
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

test('B1 only an explicit unverifiable verdict can arm interruption', async () => {
  const h = setup();
  await h.bridge.event(event);
  h.unknown();
  h.liveness('unknown');
  for (let n = 0; n < 4; n++) await h.leads.poll();
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('unknown');
});

test('B2 a live poll cannot count toward the subsequent unknown grace window', async () => {
  const h = setup();
  await h.bridge.event(event);
  await h.leads.poll();
  h.unknown();
  await h.leads.poll();
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('unknown');
  await h.leads.poll();
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('unknown');
  await h.leads.poll();
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('interrupted');
});

test('B3 owner free text answers an optioned question and later messages still forward', async () => {
  const h = setup();
  await h.bridge.event(event);
  await h.leads.report(report('question', {}, '{"question":"Which records?","options":["orders","users"]}', 'question'));
  await h.bridge.event({ ...event, ts: '2', threadTs: '1', eventId: 'answer', text: 'orders, for finance, filtered by month' });
  await h.bridge.event({ ...event, ts: '3', threadTs: '1', eventId: 'later', text: 'Include CSV' });
  expect(h.store.decision('question')?.answer).toBe('orders, for finance, filtered by month');
  expect(calls(h.commands, 'reply')).toHaveLength(1);
  expect(argument(calls(h.commands, 'send')[0], '--body')).toBe('Include CSV');
  expect(h.store.inbound(threadId).every(message => message.state !== 'pending')).toBe(true);
});

test('B3 an empty mention cannot block the next answer or later peer instructions', async () => {
  const h = setup();
  await h.bridge.event(event);
  await h.leads.report(report('question', {}, '{"question":"Which records?","options":["orders","users"]}', 'question'));
  await h.bridge.event({ ...event, ts: '2', threadTs: '1', eventId: 'empty', text: '<@BOT>' });
  await h.bridge.event({ ...event, ts: '3', threadTs: '1', eventId: 'answer', text: 'orders' });
  await h.bridge.event({ ...event, ts: '4', threadTs: '1', eventId: 'peer', user: 'peer', text: '<@BOT> Include CSV' });
  expect(h.store.inbound(threadId).map(message => message.state)).toEqual(['forwarded', 'archived', 'forwarded', 'forwarded']);
  expect(h.store.decision('question')?.answer).toBe('orders');
  expect(calls(h.commands, 'send')).toHaveLength(1);
});

test.each(['button', 'late question', 'late completion'])('B4 interruption survives a %s without delivery or replacement', async source => {
  const h = setup();
  await h.bridge.event(event);
  await h.leads.report(report('question', {}, '{"question":"Which records?","options":["orders"]}', 'question'));
  h.terminal('exited');
  await h.leads.poll();
  const offset = h.commands.length;
  if (source === 'button') expect(await h.bridge.action({ actionId: 'decision', threadId, channel: 'channel', user: 'owner', decisionId: 'question', option: 'orders' })).toBe(false);
  if (source === 'late question') await h.leads.report(report('question', {}, 'A queued question', 'later-question'));
  if (source === 'late completion') await h.leads.report(report('worker_done', { outcome: 'succeeded' }, 'A queued completion', 'later-done'));
  await h.bridge.event({ ...event, ts: '2', threadTs: '1', eventId: 'next', text: 'Continue' });
  await h.leads.poll();
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('interrupted');
  expect(h.store.leadSessions(threadId)[0].active).toBe(true);
  expect(h.commands.slice(offset)).toEqual([]);
});

function diskSetup() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-atomic-'));
  roots.push(root);
  const file = join(root, 'ledger.sqlite');
  return { ...setup(file), file };
}
function abortInboundCommit(file: string) {
  const db = new DatabaseSync(file);
  try { db.exec(`CREATE TRIGGER abort_forward BEFORE UPDATE ON inbound WHEN NEW.state='forwarded'
    BEGIN SELECT RAISE(ABORT, 'injected SQLite boundary failure'); END`); }
  finally { db.close(); }
}

test('SF1 launch settlement rolls back session, event, and inbound markers together', async () => {
  const h = diskSetup();
  abortInboundCommit(h.file);
  await expect(h.bridge.event(event)).rejects.toThrow('injected SQLite boundary failure');
  expect(calls(h.commands, 'worker-start')).toHaveLength(1);
  expect(h.store.leadSessions(threadId)).toEqual([]);
  expect(h.store.leadEvents(threadId).some(event => event.kind === 'started')).toBe(false);
  expect(h.store.pendingLaunch(threadId)).toBeTruthy();
  expect(h.store.inbound(threadId)[0].state).toBe('pending');
});

test('SF1 reply settlement rolls back decision, event, and inbound markers together', async () => {
  const h = diskSetup();
  await h.bridge.event(event);
  await h.leads.report(report('question', {}, 'Which records?', 'question'));
  abortInboundCommit(h.file);
  await expect(h.bridge.event({ ...event, ts: '2', threadTs: '1', eventId: 'answer', text: 'orders' })).rejects.toThrow('injected SQLite boundary failure');
  expect(calls(h.commands, 'reply')).toHaveLength(1);
  expect(h.store.decision('question')?.answer).toBeUndefined();
  expect(h.store.leadEvents(threadId).some(event => event.kind === 'answered')).toBe(false);
  expect(h.store.inbound(threadId).at(-1)?.state).toBe('pending');
});

test('SF2 failed stop preserves pending prompts until a successful replay', async () => {
  const h = setup();
  await h.bridge.event(event);
  h.fail('send');
  await expect(h.bridge.event({ ...event, ts: '2', threadTs: '1', eventId: 'pending', text: 'Keep this request' })).rejects.toThrow('uncertain command');
  h.fail('worker-stop');
  await expect(h.bridge.event({ ...event, ts: '3', threadTs: '1', eventId: 'stop', text: '!stop' })).rejects.toThrow('uncertain command');
  expect(h.store.inbound(threadId).map(message => message.state)).toEqual(['forwarded', 'pending', 'pending']);
  h.fail(undefined);
  await h.bridge.replay();
  expect(h.store.inbound(threadId).map(message => message.state)).toEqual(['forwarded', 'archived', 'forwarded']);
});

test('SF2 distinct partial launches each retain their own stopped event', async () => {
  const h = setup();
  h.partialLaunch();
  await expect(h.bridge.event(event)).rejects.toThrow('uncertain command');
  await h.bridge.event({ ...event, ts: '2', threadTs: '1', eventId: 'stop-first', text: '!stop' });
  await expect(h.bridge.event({ ...event, ts: '3', threadTs: '1', eventId: 'retry', text: 'Continue' })).rejects.toThrow('uncertain command');
  await h.bridge.event({ ...event, ts: '4', threadTs: '1', eventId: 'stop-second', text: '!stop' });
  expect(h.store.leadEvents(threadId).filter(event => event.kind === 'stopped')).toHaveLength(2);
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('stopped');
});

test('B1 the measured full worker-show projection keeps a healthy lead running', async () => {
  const h = setup();
  await h.bridge.event(event);
  await h.leads.poll();
  expect(calls(h.commands, 'worker-show')).toEqual([['orchestration', 'worker-show', '--dispatch', 'dispatch-1', '--json', '--full']]);
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('running');
});

test('R2 SF1 launch settlement replaces an interrupted session and scopes interruption to its old ID', async () => {
  const h = setup();
  await h.bridge.event(event);
  h.terminal('exited');
  await h.leads.poll();
  await h.orca.call('worker-stop', ['--dispatch', 'dispatch-1']);
  await h.orca.call('worker-start', ['--run', 'run', '--worktree', 'id:tree-1', '--agent', 'codex', '--spec', 'Authorized replacement']);
  const session = { id: 'replacement', threadId, worktreeId: 'tree-1', runId: 'run',
    taskId: 'task-2', dispatchId: 'dispatch-2', handle: 'handle-2' };
  h.store.beginLeadLaunch(threadId, session.id);
  h.store.saveLaunchDispatch(threadId, session.dispatchId);
  expect(() => h.store.completeLeadLaunch(session, [])).not.toThrow();
  expect(h.store.leadSessions(threadId).map(row => [row.dispatchId, row.active])).toEqual([['dispatch-1', false], ['dispatch-2', true]]);
  expect(h.store.pendingLaunch(threadId)).toBeUndefined();
  expect(h.store.leadEvents(threadId).some(event => event.kind === 'interrupted' && event.sessionId !== session.id)).toBe(true);
  h.terminal('running');
  await h.bridge.event({ ...event, ts: '2', threadTs: '1', eventId: 'follow-up', text: 'Continue in the replacement' });
  await h.leads.poll();
  expect(argument(calls(h.commands, 'send')[0], '--to')).toBe('dispatch:dispatch-2');
  expect(h.store.leadEvents(threadId).at(-1)).toMatchObject({ sessionId: session.id, kind: 'running' });
  h.store.beginLeadLaunch(threadId, 'rejected');
  expect(() => h.store.completeLeadLaunch({ ...session, id: 'rejected', dispatchId: 'dispatch-3', worktreeId: 'missing-tree' }, [])).toThrow();
  expect(h.store.leadSessions(threadId).map(row => [row.dispatchId, row.active])).toEqual([['dispatch-1', false], ['dispatch-2', true]]);
  expect(h.store.pendingLaunch(threadId)).toBe('rejected');
});

test('R2 SF2 a bare-mention root receives one routing sample and a repository-required event', async () => {
  const h = setup();
  await h.bridge.event({ ...event, text: '<@BOT>' });
  expect(h.store.routingSamples(threadId)).toEqual([{ threadId, text: '<@BOT>', repository: null, intent: 'clarify', rule: 'unknown-repository' }]);
  expect(h.store.leadEvents(threadId).at(-1)?.kind).toBe('repository-required');
  expect(h.store.inbound(threadId)[0].state).toBe('pending');
  await h.bridge.event({ ...event, ts: '2', threadTs: '1', eventId: 'later' });
  expect(h.store.routingSamples(threadId)).toHaveLength(1);
  expect(calls(h.commands, 'worker-start')).toHaveLength(0);
});

test.each(['worker-stop', 'queued action'])('R2 SF3 button stop preserves prompts saved after the click during %s', async phase => {
  const h = setup();
  await h.bridge.event(event);
  let stopping: Promise<boolean>;
  let preceding: Promise<void> | undefined;
  let gate;
  if (phase === 'worker-stop') {
    h.fail('send');
    await expect(h.bridge.event({ ...event, ts: '2', threadTs: '1', eventId: 'before', text: 'Before the click' })).rejects.toThrow('uncertain command');
    h.fail(undefined);
    gate = h.block('worker-stop');
    stopping = h.bridge.action({ actionId: 'stop', threadId, channel: 'channel', user: 'owner' });
    await gate.ready;
  } else {
    gate = h.block('send');
    preceding = h.bridge.event({ ...event, ts: '2', threadTs: '1', eventId: 'before', text: 'Before the click' });
    await gate.ready;
    stopping = h.bridge.action({ actionId: 'stop', threadId, channel: 'channel', user: 'owner' });
  }
  const following = h.bridge.event({ ...event, ts: '3', threadTs: '1', eventId: 'after', text: 'After the click' });
  expect(h.store.inbound(threadId).at(-1)?.state).toBe('pending');
  gate.release();
  await Promise.all([preceding, stopping, following]);
  expect(h.store.inbound(threadId).map(message => message.state)).toEqual(['forwarded', phase === 'worker-stop' ? 'archived' : 'forwarded', 'forwarded']);
  expect(calls(h.commands, 'worker-start')).toHaveLength(2);
  expect(argument(calls(h.commands, 'worker-start')[1], '--spec')).toContain('After the click');
});

test('an empty interrupted launch clears after the in-flight grace and the next message starts exactly one lead', async () => {
  vi.useFakeTimers();
  const h = setup(); h.fail('worker-start');
  await expect(h.bridge.event(event)).rejects.toThrow('uncertain command');
  const launch = h.store.pendingLaunch(threadId);
  h.fail(undefined);
  await h.leads.poll();
  await vi.advanceTimersByTimeAsync(59_999);
  await h.leads.poll();
  expect(h.store.pendingLaunch(threadId)).toBe(launch);
  await vi.advanceTimersByTimeAsync(1);
  await h.leads.poll();
  expect(h.store.pendingLaunch(threadId)).toBeUndefined();
  await h.bridge.event({ ...event, eventId: 'retry-empty', ts: '2', threadTs: '1', text: 'Try the web fix again' });
  await h.bridge.replay();
  await h.leads.poll();
  expect(h.store.activeLeads()).toHaveLength(1);
  expect(calls(h.commands, 'worker-start')).toHaveLength(2);
  expect(argument(calls(h.commands, 'worker-start')[1], '--spec')).toContain('Try the web fix again');
});
