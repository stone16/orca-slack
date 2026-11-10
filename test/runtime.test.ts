import { fork } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import ts from 'typescript';
import { App, type ReceiverEvent } from '@slack/bolt';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { SlackAdapter, registerHandlers, type AdapterOptions, type SlackClient } from '../src/bolt.js';
import { parseConfig } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import type { RunCommand } from '../src/commands.js';

const roots: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
function fixture(realBolt = false) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-runtime-'));
  roots.push(root);
  const checkout = join(root, 'bridge'), archive = join(root, 'archive');
  mkdirSync(checkout); mkdirSync(archive); mkdirSync(join(checkout, 'data'));
  writeFileSync(join(archive, '.orca-slack-archive'), '');
  const config = parseConfig({ botId: 'U00000001', ownerId: 'U00000002', allowedUsers: ['U00000002'],
    runId: 'run_fixture', coordinatorTerminal: 'term_fixture', agent: 'codex',
    archiveDirectory: archive, hooksDirectory: join(root, 'hooks'), retentionDays: 1,
    repositories: [{ id: 'repo-fixture', name: 'example', aliases: [], path: join(root, 'repo'), github: 'example/project' }],
  }, { SLACK_BOT_TOKEN: 'xoxb-fixture', SLACK_APP_TOKEN: 'xapp-fixture' }, checkout);
  const file = join(checkout, 'data', 'bridge.sqlite');
  const store = new Store(file);
  const thread = { id: 'thread', channel: 'C1', threadTs: '1', owner: config.ownerId };
  store.saveThread(thread);
  store.saveWorktree({ id: 'tree', threadId: 'thread', repository: 'repo-fixture', branch: 'feature' });
  store.replaceLead({ id: 'session', threadId: 'thread', worktreeId: 'tree', runId: config.runId,
    taskId: 'task', dispatchId: 'dispatch', handle: 'handle' });
  store.saveInbound(thread, { installationId: 'A:T', eventId: 'event', channel: 'C1', ts: '2', threadTs: '1', user: config.ownerId, text: 'example Follow up' }, 'prompt');
  store.close();
  const commands: { program: string; args: string[] }[] = [];
  const control = { prState: 'OPEN', worktreePresent: true, failStart: false, failSend: false, failReaction: false, workerListDelay: 0, terminalStatus: 'running',
    workers: [] as { dispatchId: string; taskId: string; runId: string; agentTerminalHandle: string; projection: { workspace: { id: string } } }[] };
  const treePath = join(root, 'worktree'); mkdirSync(treePath);
  const messages: { id: string; type: string; sequence: number; payload: string; body: string }[] = [];
  let unread = false;
  let workerListReads = 0;
  let blocked: { verb: string; entered: () => void; wait: Promise<void> } | undefined;
  const run: RunCommand = async (program, args) => {
    commands.push({ program, args });
    if (program === 'orca' && blocked?.verb === args[1]) {
      const current = blocked; blocked = undefined; current.entered(); await current.wait;
    }
    if (program === 'gh') return JSON.stringify([{ number: 7, url: 'https://github.com/example/project/pull/7', state: control.prState, headRefOid: 'a'.repeat(40) }]);
    if (program === 'git') {
      if (args.includes('--show-toplevel')) return treePath;
      if (args.includes('symbolic-ref')) return 'refs/heads/feature';
      if (args.includes('HEAD')) return 'a'.repeat(40);
      return '';
    }
    let result: unknown = {};
    if (args[0] === 'worktree' && args[1] === 'ps') result = { truncated: false, worktrees: control.worktreePresent ? [{ worktreeId: 'tree', worktreeInstanceId: 'instance', hostId: 'local', agents: [{ liveness: 'exited' }], unverifiableTerminalCount: 0 }] : [] };
    if (args[0] === 'worktree' && args[1] === 'show') result = { worktree: { id: 'tree', instanceId: 'instance', identity: { key: 'identity' }, hostId: 'local', path: treePath, isMainWorktree: false } };
    if (args[0] === 'worktree' && args[1] === 'rm') { rmSync(treePath, { recursive: true }); control.worktreePresent = false; }
    if (args[1] === 'send' && control.failSend) throw new Error('scripted forwarding unavailable');
    if (args[1] === 'worker-start' && control.failStart) throw new Error('scripted start unavailable');
    if (args[1] === 'worker-start') result = { dispatchId: 'new-dispatch', taskId: 'new-task', runId: config.runId, effects: [{ kind: 'terminal', role: 'agent', id: 'new-handle' }] };
    if (args[1] === 'worker-list') result = { workers: ++workerListReads <= control.workerListDelay ? [] : control.workers, page: { hasMore: false, nextCursor: null } };
    if (args[1] === 'inbox') result = { count: messages.length, messages };
    if (args[1] === 'check') {
      result = { messages: unread ? messages : [] };
      if (!args.includes('--peek')) unread = false;
    }
    if (args[1] === 'worker-show') result = { projection: { liveness: { verdict: 'live' } }, observation: { agentWait: null } };
    if (args[1] === 'worker-read') result = { source: 'transcript', cursor: '1' };
    if (args[0] === 'terminal') result = { status: control.terminalStatus, source: 'terminal', nextCursor: '1' };
    return JSON.stringify({ ok: true, result });
  };
  const posts: Record<string, unknown>[] = [], reactions: string[] = [], lifecycle: string[] = [], logs: string[] = [];
  let sequence = 0;
  const client: SlackClient = { chat: {
    postMessage: async args => { posts.push({ ...args }); return { ts: `${++sequence}` }; },
    update: async args => { posts.push({ ...args }); }, postEphemeral: async () => {},
  }, reactions: { add: async args => { if (control.failReaction) throw new Error('scripted reaction unavailable'); reactions.push(args.name); } }, views: { open: async () => {} } };
  const socket = new EventEmitter();
  let bolt: App | undefined;
  let options!: AdapterOptions;
  let adapter!: SlackAdapter;
  let release: (() => void) | undefined;
  let pauseStep: string | undefined;
  const checkpoint = async (step: string) => {
    if (step === pauseStep) await new Promise<void>(resolve => { release = resolve; });
  };
  const createRuntime = () => {
    const runtime = new Runtime(config, { run, log: (level, message) => logs.push(`${level} ${message}`),
      installGuard: (repository, directory) => { commands.push({ program: 'guard', args: [repository, directory] }); return join(directory, 'pre-push'); },
      checkpoint,
      socketMode: (store, supplied) => {
        options = supplied;
        adapter = new SlackAdapter(client, store, supplied);
        const receiver = { init: () => {}, start: async () => { lifecycle.push('connected'); socket.emit('connected'); }, stop: async () => { lifecycle.push('disconnected'); } };
        if (realBolt) {
          bolt = new App({ receiver, token: 'fixture-token', botId: 'B1', botUserId: config.botId, tokenVerificationEnabled: false });
          bolt.error(async error => { logs.push(error.message); });
          registerHandlers(bolt, adapter, supplied.handle);
        }
        return { adapter, socket, app: bolt ?? receiver };
      },
    });
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = createRuntime();
  return { restart: createRuntime, root, config, file, control, socket, commands, posts, reactions, lifecycle, logs, runtime,
    receive: (body: ReceiverEvent['body'], ack: () => Promise<void>) => bolt!.processEvent({ body, ack }),
    adapter: () => adapter, options: () => options,
    addReport: (type = 'question', outcome?: string, body = 'Choose a color', identity = { dispatchId: 'dispatch', taskId: 'task' }, id = 'report') => { messages.push({ id, sequence: messages.length + 1, type, body,
      payload: JSON.stringify({ ...identity, outcome }) }); unread = true; },
    block: (verb: string) => {
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      blocked = { verb, entered, wait };
      return { ready, release };
    },
    pause: (step: string) => { pauseStep = step; release = undefined; }, release: () => release?.(), paused: () => !!release,
  };
}

test('runtime composes the modules, replays once, and schedules report, PR, lead, and retention jobs once', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const { UnboundThreads } = await import('../src/unbound-threads.js');
  new UnboundThreads({ checkout: f.config.checkout }).append({ id: 'unbound', channel: 'C2', threadTs: '3', owner: f.config.ownerId },
    { installationId: 'A:T', eventId: 'old', channel: 'C2', ts: '3', user: f.config.ownerId, text: 'Unrouted' }, Date.now() - 172_800_000);
  await Promise.all([f.runtime.start(), f.runtime.start()]);
  expect(f.lifecycle).toEqual(['connected']);
  expect(f.commands.filter(command => command.program === 'guard')).toHaveLength(1);
  expect(f.commands.filter(command => command.args[1] === 'inbox')).toHaveLength(1);
  expect(f.commands.filter(command => command.args[1] === 'send')).toHaveLength(1);
  expect(f.reactions).toEqual(['eyes', 'white_check_mark']);
  expect(f.commands.filter(command => command.program === 'gh')).toEqual([expect.objectContaining({ args: expect.arrayContaining(['--repo', 'example/project']) })]);
  expect(new UnboundThreads({ checkout: f.config.checkout, archiveDirectory: f.config.archiveDirectory }).read('unbound')?.messages[0].text).toBe('Unrouted');
  expect(f.logs.filter(line => line.includes('retention complete'))).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.commands.filter(command => command.program === 'gh')).toHaveLength(2);
  expect(f.commands.filter(command => command.args[1] === 'worker-show')).toHaveLength(13);
  expect(f.commands.filter(command => command.args[1] === 'check')).toHaveLength(24);
  expect(f.commands.filter(command => command.args[1] === 'send')).toHaveLength(1);
  expect(f.logs.filter(line => line.includes('startup replay complete'))).toHaveLength(1);
  await f.runtime.stop();
  const count = f.commands.length;
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(f.commands).toHaveLength(count);
  expect(f.lifecycle).toEqual(['connected', 'disconnected']);
});

test('shutdown drains a paused report and inbound handler before closing the durable ledger', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.runtime.start();
  f.addReport(); f.pause('after-consume');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.paused()).toBe(true);
  let handlerRelease!: () => void;
  const handler = f.options().handle!(() => new Promise<void>(resolve => { handlerRelease = resolve; }));
  let stopped = false;
  const stopping = f.runtime.stop().then(() => { stopped = true; });
  await vi.advanceTimersByTimeAsync(1);
  expect(stopped).toBe(false);
  expect(f.lifecycle).toContain('disconnected');
  let accepted = false;
  await f.options().handle!(async () => { accepted = true; });
  expect(accepted).toBe(false);
  f.release(); handlerRelease();
  await handler; await stopping;
  const reopened = new Store(f.file);
  try {
    expect(reopened.reports(f.config.runId)).toEqual([expect.objectContaining({ id: 'report', state: 'sent', sequence: 1 })]);
    expect(reopened.decision('report')?.slackTs).toMatch(/^\d+$/);
  } finally { reopened.close(); }
});

test('startup failures disconnect and close the ledger without starting timers', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.commands.length = 0;
  const bad = new Runtime(f.config, { run: async () => { throw new Error('offline'); }, installGuard: () => { throw new Error('guard conflict'); } });
  runtimes.push(bad);
  await expect(bad.start()).rejects.toThrow('repositories[0].path');
  await bad.stop();
  const reopened = new Store(f.file); reopened.close();
  expect(vi.getTimerCount()).toBe(0);
});


test('a failed report exposes one durable owner retry and starts a replacement lead once', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.runtime.start();
  f.addReport('worker_done', 'failed'); await vi.advanceTimersByTimeAsync(5_000);
  const store = new Store(f.file);
  const resultTs = store.slackCard('thread', 'result:report')!.ts;
  const click = { actionId: 'retry', value: JSON.stringify({ threadId: 'thread', resultId: 'report' }),
    channel: 'C1', user: f.config.ownerId, messageTs: resultTs, triggerId: 'trigger' };
  try {
    await f.adapter().action(click); await f.adapter().action(click);
    expect(f.commands.filter(command => command.args[1] === 'worker-start')).toHaveLength(1);
    expect(store.leadSessions('thread').filter(session => session.active)).toEqual([expect.objectContaining({ dispatchId: 'new-dispatch' })]);
    expect(store.inbound('thread')[0].state).toBe('forwarded');
    expect(JSON.parse(store.slackCard('thread', 'result:report')!.view).retriedBy).toBe(f.config.ownerId);
  } finally { store.close(); }
});

test('owner cleanup uses the composed gh, git, and Orca boundaries and preserves its receipt', async () => {
  vi.useFakeTimers();
  const f = fixture(); f.control.prState = 'MERGED';
  await f.runtime.start(); f.addReport('worker_done', 'succeeded'); await vi.advanceTimersByTimeAsync(5_000);
  const store = new Store(f.file);
  const ts = store.slackCard('thread', 'status')!.ts;
  try {
    await f.adapter().action({ actionId: 'cleanup', value: JSON.stringify({ threadId: 'thread' }), channel: 'C1',
      user: f.config.ownerId, messageTs: ts, triggerId: 'trigger' });
    expect(f.commands.some(command => command.program === 'git' && command.args.includes('status'))).toBe(true);
    expect(store.cleanupReceipt('tree')).toEqual(expect.objectContaining({ state: 'deleted', confirmedBy: f.config.ownerId, finalCommit: 'a'.repeat(40) }));
    expect(JSON.parse(store.slackCard('thread', 'status')!.view).state).toBe('cleaned');
  } finally { store.close(); }
});


for (const kind of ['message', 'button']) {
  test(`an acknowledged ${kind} drains through the real Bolt boundary when shutdown begins in ack`, async () => {
    const f = fixture(true); await f.runtime.start();
    const store = new Store(f.file);
    let stopping: Promise<void> | undefined;
    let acked = false;
    try {
      let body: ReceiverEvent['body'];
      if (kind === 'message') body = { type: 'event_callback', api_app_id: 'A', team_id: 'T', event_id: 'during-stop',
        event: { type: 'message', channel: 'C1', user: f.config.ownerId, ts: '3', thread_ts: '1', text: 'Saved during stop' } };
      else {
        body = JSON.parse(readFileSync(new URL('./fixtures/slack-action.json', import.meta.url), 'utf8'));
        body.channel = { id: 'C1', name: 'fixture' }; body.user = { id: f.config.ownerId };
        body.message = { ts: store.slackCard('thread', 'status')!.ts };
        body.actions = [{ type: 'button', action_id: 'stop', value: JSON.stringify({ threadId: 'thread' }) }];
      }
      await f.receive(body, async () => { acked = true; stopping = f.runtime.stop(); });
      await stopping;
      expect(acked).toBe(true);
      if (kind === 'message') expect(store.inbound('thread')).toContainEqual(expect.objectContaining({ eventId: 'during-stop', text: 'Saved during stop' }));
      else expect(store.leadEvents('thread')).toContainEqual(expect.objectContaining({ kind: 'stopped' }));
    } finally { store.close(); }
  });
}

test('startup reconciles completion and replays the pending prompt before Socket Mode accepts traffic', async () => {
  vi.useFakeTimers();
  const f = fixture(); f.addReport('worker_done', 'succeeded'); f.pause('after-inbox');
  const starting = f.runtime.start();
  await vi.advanceTimersByTimeAsync(0);
  try { expect(f.paused()).toBe(true); expect(f.lifecycle).toEqual([]); }
  finally { f.release(); await starting; }
  expect(f.lifecycle).toEqual(['connected']);
  expect(f.commands.filter(command => command.args[1] === 'send')).toHaveLength(0);
  expect(f.commands.filter(command => command.args[1] === 'worker-start')).toHaveLength(1);
  const store = new Store(f.file);
  try { expect(store.inbound('thread')[0].state).toBe('forwarded'); expect(store.activeLeads()[0].dispatchId).toBe('new-dispatch'); }
  finally { store.close(); }
});


test('the real Bolt boundary leaves new traffic unacknowledged once shutdown has closed admission', async () => {
  const f = fixture(true); await f.runtime.start(); await f.runtime.stop();
  let acked = false;
  await f.receive({ type: 'event_callback', api_app_id: 'A', team_id: 'T', event_id: 'after-stop',
    event: { type: 'message', channel: 'C1', user: f.config.ownerId, ts: '4', thread_ts: '1', text: 'Redeliver later' } }, async () => { acked = true; });
  expect(acked).toBe(false);
});


test('an unconfirmed retry launch keeps its action available on repeated owner clicks', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.runtime.start();
  f.addReport('worker_done', 'failed'); await vi.advanceTimersByTimeAsync(5_000);
  const store = new Store(f.file); f.control.failStart = true;
  const click = { actionId: 'retry', value: JSON.stringify({ threadId: 'thread', resultId: 'report' }), channel: 'C1',
    user: f.config.ownerId, messageTs: store.slackCard('thread', 'result:report')!.ts, triggerId: 'trigger' };
  try {
    await expect(f.adapter().action(click)).rejects.toThrow();
    expect(store.slackAction('thread', JSON.stringify(['result:report', 'retry', '']))).toBeUndefined();
    await expect(f.adapter().action(click)).rejects.toThrow('Retry launch is not confirmed');
    expect(JSON.parse(store.slackCard('thread', 'result:report')!.view).retriedBy).toBeUndefined();
    expect(store.inbound('thread')[0].state).toBe('pending');
    expect(f.commands.filter(command => command.args[1] === 'worker-start')).toHaveLength(1);
  } finally { store.close(); }
});

test('owner retry skips an archived empty mention and requeues the last real prompt', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.runtime.start();
  await f.adapter().event({ installationId: 'A:T', eventId: 'empty', channel: 'C1', ts: '3', threadTs: '1', user: f.config.ownerId, text: `<@${f.config.botId}>` });
  f.addReport('worker_done', 'failed'); await vi.advanceTimersByTimeAsync(5_000);
  const store = new Store(f.file);
  try {
    await f.adapter().action({ actionId: 'retry', value: JSON.stringify({ threadId: 'thread', resultId: 'report' }), channel: 'C1',
      user: f.config.ownerId, messageTs: store.slackCard('thread', 'result:report')!.ts, triggerId: 'trigger' });
    expect(f.commands.filter(command => command.args[1] === 'worker-start')).toHaveLength(1);
    expect(store.inbound('thread').find(message => message.eventId === 'empty')?.state).toBe('archived');
    expect(store.activeLeads()[0].dispatchId).toBe('new-dispatch');
  } finally { store.close(); }
});


test('retry intent survives reopening and recognizes a completed replacement without requeueing it', () => {
  const f = fixture();
  let store = new Store(f.file);
  try {
    store.markInboundForwarded(store.inbound('thread')[0].key);
    store.recordLeadEvent({ threadId: 'thread', key: 'failed', sessionId: 'session', kind: 'failed', text: 'Failed' }, 'session');
    store.requestRetry('thread', 'retry-key', f.config.ownerId);
    expect(store.slackAction('thread', 'retry-key')).toBeUndefined();
    store.close(); store = new Store(f.file);
    expect(store.inbound('thread')[0].state).toBe('pending');
    store.completeLeadLaunch({ id: 'replacement', threadId: 'thread', worktreeId: 'tree', runId: f.config.runId,
      taskId: 'replacement-task', dispatchId: 'replacement-dispatch', handle: 'replacement-handle' }, [store.inbound('thread')[0].key]);
    store.endLead('replacement');
    store.requestRetry('thread', 'retry-key', f.config.ownerId);
    expect(store.retryStarted('thread', 'retry-key')).toBe(true);
    expect(store.inbound('thread')[0].state).toBe('forwarded');
    expect(store.leadSessions('thread')).toHaveLength(2);
  } finally { store.close(); }
});


for (const phase of ['interrupted', 'stopped', 'replaced'] as const) for (const outcome of ['succeeded', 'failed']) {
  test(`late ${outcome} reports from ${phase} sessions never publish a result card`, async () => {
    vi.useFakeTimers();
    const f = fixture(); const store = new Store(f.file);
    try {
      store.markInboundForwarded(store.inbound('thread')[0].key);
      if (phase === 'replaced') store.replaceLead({ id: 'replacement', threadId: 'thread', worktreeId: 'tree', runId: f.config.runId,
        taskId: 'replacement-task', dispatchId: 'replacement-dispatch', handle: 'replacement-handle' });
      else store.recordLeadEvent({ threadId: 'thread', key: phase, sessionId: 'session', kind: phase, text: phase }, phase === 'stopped' ? 'session' : undefined);
      await f.runtime.start(); f.addReport('worker_done', outcome, 'Late result must stay hidden');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.posts.map(post => post.text).join('\n')).not.toContain('Late result must stay hidden');
      expect(store.slackCard('thread', 'result:report')).toBeUndefined();
      expect(store.leadEvents('thread').some(event => event.key === 'report')).toBe(false);
    } finally { store.close(); }
  });
}

test('an accepted completion replays its result after the session has already ended', async () => {
  const f = fixture(); const store = new Store(f.file);
  try {
    store.markInboundForwarded(store.inbound('thread')[0].key);
    store.recordLeadEvent({ threadId: 'thread', key: 'report', sessionId: 'session', kind: 'completed', text: 'Confirmed result' }, 'session');
    f.addReport('worker_done', 'succeeded', 'Confirmed result');
    await f.runtime.start();
    expect(f.posts.filter(post => String(post.text).includes('Confirmed result'))).toHaveLength(1);
    expect(store.reports(f.config.runId)[0].state).toBe('sent');
  } finally { store.close(); }
});

test('optioned questions publish the question text and buttons without exposing their JSON envelope', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.runtime.start();
  f.addReport('question', undefined, JSON.stringify({ question: 'Which records?', options: ['orders', 'users'] }));
  await vi.advanceTimersByTimeAsync(5_000);
  const post = f.posts.find(post => String(post.text).includes('Which records?'));
  expect(post?.text).not.toContain('"question"'); expect(post?.text).not.toContain('"options"');
  expect(JSON.stringify(post?.blocks)).toContain('"text":"orders"');
  expect(JSON.stringify(post?.blocks)).toContain('"text":"users"');
});

test('accepted completion refreshes its pull request state immediately before the next timer poll', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.runtime.start();
  f.control.prState = 'MERGED'; f.addReport('worker_done', 'succeeded');
  await vi.advanceTimersByTimeAsync(5_000);
  const store = new Store(f.file);
  try { expect(JSON.parse(store.slackCard('thread', 'status')!.view).state).toBe('awaiting-verification'); }
  finally { store.close(); }
});


for (const failure of ['forwarding', 'reaction']) for (const trigger of ['poll', 'reconnect']) {
  test(`resident ${trigger} replays a transient ${failure} failure without another Slack message`, async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.runtime.start();
    f.control.failSend = failure === 'forwarding'; f.control.failReaction = failure === 'reaction';
    await expect(f.adapter().event({ installationId: 'A:T', eventId: 'transient', channel: 'C1', ts: '3', threadTs: '1', user: f.config.ownerId, text: 'Follow up once' })).rejects.toThrow();
    const store = new Store(f.file);
    try {
      const message = store.inbound('thread').find(message => message.eventId === 'transient')!;
      expect(message.state).toBe(failure === 'forwarding' ? 'pending' : 'forwarded');
      expect(store.hasSlackReaction(message.key, 'white_check_mark')).toBe(false);
      f.control.failSend = false; f.control.failReaction = false;
      if (trigger === 'poll') await vi.advanceTimersByTimeAsync(5_000);
      else { f.socket.emit('reconnecting'); f.socket.emit('connected'); await vi.advanceTimersByTimeAsync(0); }
      expect(store.inbound('thread').find(message => message.eventId === 'transient')?.state).toBe('forwarded');
      expect(store.hasSlackReaction(message.key, 'white_check_mark')).toBe(true);
    } finally { store.close(); }
  });
}

test('unbound M1 threads never display the unavailable repository switch action', async () => {
  const f = fixture(); await f.runtime.start();
  await f.adapter().event({ installationId: 'A:T', eventId: 'unrouted', channel: 'C2', ts: '4', user: f.config.ownerId, text: `<@${f.config.botId}> clarify something` });
  const posts = f.posts.filter(post => post.channel === 'C2');
  expect(posts.length).toBeGreaterThan(0);
  expect(JSON.stringify(posts)).not.toContain('"action_id":"switch-repository"');
  expect(JSON.stringify(posts)).toContain('"action_id":"stop"');
});

test('unexpected Socket Mode reconnects produce an operational log line', async () => {
  const f = fixture(); await f.runtime.start(); f.socket.emit('reconnecting');
  expect(f.logs).toContain('warn Socket Mode reconnecting');
});

test('reconnect processes a recovered completion before replaying a queued follow-up', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.runtime.start();
  f.control.failSend = true;
  await expect(f.adapter().event({ installationId: 'A:T', eventId: 'queued', channel: 'C1', ts: '3', threadTs: '1', user: f.config.ownerId, text: 'Queued while disconnected' })).rejects.toThrow();
  f.control.failSend = false; f.addReport('worker_done', 'succeeded');
  f.socket.emit('reconnecting'); f.socket.emit('connected'); await vi.advanceTimersByTimeAsync(0);
  const store = new Store(f.file);
  try {
    expect(store.activeLeads()[0]?.dispatchId).toBe('new-dispatch');
    expect(store.inbound('thread').find(message => message.eventId === 'queued')?.state).toBe('forwarded');
    expect(f.commands.filter(command => command.args[1] === 'send' && command.args.includes('Queued while disconnected'))).toHaveLength(1);
  } finally { store.close(); }
});

async function killDuringLaunch(f: ReturnType<typeof fixture>) {
  const modules = join(f.root, 'modules'); mkdirSync(modules);
  writeFileSync(join(modules, 'package.json'), '{"type":"module"}');
  for (const name of ['leads', 'lead-orca', 'orca', 'store', 'routing']) {
    const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
    writeFileSync(join(modules, `${name}.js`), ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
    }).outputText);
  }
  const script = join(modules, 'launch.mjs');
  writeFileSync(script, `
    import { Store } from './store.js';
    import { Leads } from './leads.js';
    import { LeadCli } from './lead-orca.js';
    const store = new Store(process.argv[2]);
    const orca = new LeadCli(async args => {
      if (args[1] !== 'worker-start') throw new Error('Unexpected command');
      process.send({ dispatchId: 'adopted', taskId: 'adopted-task', runId: 'run_fixture',
        agentTerminalHandle: 'adopted-handle', projection: { workspace: { id: 'tree' } } });
      setInterval(() => {}, 1000);
      return new Promise(() => {});
    });
    await new Leads(orca, store, { runId: 'run_fixture', repositories: [
      { id: 'repo-fixture', name: 'example', aliases: [] }
    ], botId: 'U00000001', agent: 'codex' }).forward('thread');
  `);
  const child = fork(script, [f.file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    const [worker] = await once(child, 'message');
    f.control.workers.push(worker);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    expect(await exited).toEqual([null, 'SIGKILL']);
    return worker as (typeof f.control.workers)[number];
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}

test('restart adopts a worker killed between worker-start and saveLaunchDispatch and posts its completion once', async () => {
  vi.useFakeTimers();
  const f = fixture(); const store = new Store(f.file);
  try {
    store.endLead('session');
    const worker = await killDuringLaunch(f);
    expect(store.pendingLaunch('thread')).toBeTruthy();
    expect(store.launchDispatch('thread')).toBeFalsy();
    await f.runtime.start();
    expect(store.activeLeads()).toMatchObject([{ dispatchId: 'adopted', handle: 'adopted-handle' }]);
    expect(store.pendingLaunch('thread')).toBeUndefined();
    f.addReport('worker_done', 'succeeded', 'Recovered result', worker);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.posts.filter(post => String(post.text).includes('Recovered result'))).toHaveLength(1);
    expect(JSON.parse(store.slackCard('thread', 'status')!.view).state).not.toBe('unknown');
    expect(f.commands.filter(command => command.args[1] === 'worker-start')).toHaveLength(0);
  } finally { store.close(); }
});

test('a stored report dropped before adoption is replayed once across further restarts', async () => {
  vi.useFakeTimers();
  const f = fixture(); const store = new Store(f.file);
  try {
    store.endLead('session');
    const worker = await killDuringLaunch(f);
    f.control.workers.length = 0;
    f.addReport('worker_done', 'succeeded', 'Previously dropped result', worker);
    await f.runtime.start();
    expect(store.reports(f.config.runId)[0].state).toBe('pending');
    store.markReportSent(f.config.runId, 'report');
    expect(store.slackCard('thread', 'result:report')).toBeUndefined();
    f.control.workers.push(worker);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.posts.filter(post => String(post.text).includes('Previously dropped result'))).toHaveLength(1);
    expect(store.reports(f.config.runId)[0].state).toBe('sent');
    expect(store.leadEvents('thread').filter(event => event.key === 'report')).toHaveLength(1);
    await f.runtime.stop();
    const restarted = f.restart();
    await restarted.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await restarted.stop();
    expect(f.posts.filter(post => String(post.text).includes('Previously dropped result'))).toHaveLength(1);
    expect(store.leadSessions('thread').filter(session => session.dispatchId === worker.dispatchId)).toHaveLength(1);
  } finally { store.close(); }
});

test('a completed worker discovered on a later poll replays its report before observing its exited terminal', async () => {
  vi.useFakeTimers();
  const f = fixture(); const store = new Store(f.file);
  try {
    store.endLead('session');
    const worker = await killDuringLaunch(f);
    f.control.workerListDelay = 1;
    f.control.terminalStatus = 'exited';
    f.addReport('worker_done', 'succeeded', 'Completed during discovery', worker);
    await f.runtime.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.posts.filter(post => String(post.text).includes('Completed during discovery'))).toHaveLength(1);
    expect(store.leadEvents('thread').at(-1)?.kind).toBe('completed');
  } finally { store.close(); }
});

test.each(['startup', 'poll'])('SF1 a pending stop fences an adopted dispatch before completion delivery at %s', async trigger => {
  vi.useFakeTimers();
  const f = fixture(); const store = new Store(f.file);
  try {
    store.endLead('session');
    const worker = await killDuringLaunch(f);
    f.control.workers.length = 0;
    const stop = { installationId: 'A:T', eventId: 'pending-stop', channel: 'C1', ts: '3', threadTs: '1', user: f.config.ownerId, text: '!stop' };
    if (trigger === 'poll') {
      await f.runtime.start();
      await expect(f.adapter().event(stop)).rejects.toThrow('Cannot verify stop');
    } else store.saveInbound(store.thread('thread')!, stop, 'stop');
    f.control.workers.push(worker);
    f.addReport('worker_done', 'succeeded', 'Do not publish a stopped result', worker);
    if (trigger === 'startup') await f.runtime.start();
    else await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.posts.map(post => post.text).join('\n')).not.toContain('Do not publish a stopped result');
    expect(store.slackCard('thread', 'result:report')).toBeUndefined();
    expect(store.leadEvents('thread').at(-1)?.kind).toBe('stopped');
    expect(store.inbound('thread').find(message => message.eventId === 'pending-stop')?.state).toBe('forwarded');
    expect(f.commands.filter(command => command.args[1] === 'worker-stop')).toEqual([
      expect.objectContaining({ args: expect.arrayContaining(['--dispatch', worker.dispatchId]) }),
    ]);
  } finally { store.close(); }
});

test('SF2 a report requeued during flush remains pending until its result is delivered', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.runtime.start();
  const store = new Store(f.file); store.endLead('session');
  f.pause('after-peek'); await vi.advanceTimersByTimeAsync(5_000);
  expect(f.paused()).toBe(true);
  const gate = f.block('worker-start');
  const launching = f.adapter().event({ installationId: 'A:T', eventId: 'fast-launch', channel: 'C1', ts: '3', threadTs: '1',
    user: f.config.ownerId, text: 'example Start the next change' });
  try {
    await gate.ready;
    f.addReport('worker_done', 'succeeded', 'Fast launch result', { dispatchId: 'new-dispatch', taskId: 'new-task' });
    f.release(); f.pause('after-send'); await vi.advanceTimersByTimeAsync(0);
    expect(f.paused()).toBe(true);
    expect(store.leadSessions('thread').some(session => session.dispatchId === 'new-dispatch')).toBe(false);
    gate.release(); await launching;
    f.release(); f.pause('none'); await vi.advanceTimersByTimeAsync(0);
    expect(store.reports(f.config.runId)[0].state).toBe('pending');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.posts.filter(post => String(post.text).includes('Fast launch result'))).toHaveLength(1);
    expect(store.reports(f.config.runId)[0].state).toBe('sent');
  } finally { gate.release(); f.release(); await launching; store.close(); }
});

test('SF3 an in-flight launch leaves other threads delivering reports on successive polls', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.runtime.start();
  const store = new Store(f.file);
  const threadId = JSON.stringify(['C2', '10']);
  store.saveThread({ id: threadId, channel: 'C2', threadTs: '10', owner: f.config.ownerId });
  store.saveWorktree({ id: 'other-tree', threadId, repository: 'repo-fixture', branch: 'other-feature' });
  const gate = f.block('worker-start');
  const launching = f.adapter().event({ installationId: 'A:T', eventId: 'slow-launch', channel: 'C2', ts: '11', threadTs: '10',
    user: f.config.ownerId, text: 'example Start a slow launch' });
  try {
    await gate.ready;
    f.addReport('question', undefined, 'Other thread question');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.posts.filter(post => String(post.text).includes('Other thread question'))).toHaveLength(1);
    expect(store.pendingLaunch(threadId)).toBeTruthy();
    f.addReport('worker_done', 'succeeded', 'Other thread result', undefined, 'completion');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.posts.filter(post => String(post.text).includes('Other thread result'))).toHaveLength(1);
    expect(store.pendingLaunch(threadId)).toBeTruthy();
    expect(f.commands.filter(command => command.args[1] === 'worker-list')).toHaveLength(0);
  } finally { gate.release(); await launching; store.close(); }
});

test('SF1 a saved stop suppresses replay of an accepted but unpublished completion', async () => {
  const f = fixture(); const store = new Store(f.file);
  try {
    store.markInboundForwarded(store.inbound('thread')[0].key);
    store.recordLeadEvent({ threadId: 'thread', key: 'report', sessionId: 'session', kind: 'completed', text: 'Unpublished result' }, 'session');
    store.saveInbound(store.thread('thread')!, { installationId: 'A:T', eventId: 'stop-before-publish', channel: 'C1', ts: '3', threadTs: '1',
      user: f.config.ownerId, text: '!stop' }, 'stop');
    f.addReport('worker_done', 'succeeded', 'Unpublished result');
    await f.runtime.start();
    expect(store.leadEvents('thread').at(-1)?.kind).toBe('stopped');
    expect(store.slackCard('thread', 'result:report')).toBeUndefined();
    expect(f.posts.map(post => post.text).join('\n')).not.toContain('Unpublished result');
  } finally { store.close(); }
});
