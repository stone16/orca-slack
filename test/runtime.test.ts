import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { SlackAdapter, type AdapterOptions, type SlackClient } from '../src/bolt.js';
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
function fixture() {
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
  const control = { prState: 'OPEN', worktreePresent: true };
  const treePath = join(root, 'worktree'); mkdirSync(treePath);
  const messages: { id: string; type: string; sequence: number; payload: string; body: string }[] = [];
  let unread = false;
  const run: RunCommand = async (program, args) => {
    commands.push({ program, args });
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
    if (args[1] === 'worker-start') result = { dispatchId: 'new-dispatch', taskId: 'new-task', runId: config.runId, effects: [{ kind: 'terminal', role: 'agent', id: 'new-handle' }] };
    if (args[1] === 'inbox') result = { count: messages.length, messages };
    if (args[1] === 'check') {
      result = { messages: unread ? messages : [] };
      if (!args.includes('--peek')) unread = false;
    }
    if (args[1] === 'worker-show') result = { projection: { liveness: { verdict: 'live' } }, observation: { agentWait: null } };
    if (args[1] === 'worker-read') result = { source: 'transcript', cursor: '1' };
    if (args[0] === 'terminal') result = { status: 'running', source: 'terminal', nextCursor: '1' };
    return JSON.stringify({ ok: true, result });
  };
  const posts: Record<string, unknown>[] = [], reactions: string[] = [], lifecycle: string[] = [], logs: string[] = [];
  let sequence = 0;
  const client: SlackClient = { chat: {
    postMessage: async args => { posts.push({ ...args }); return { ts: `${++sequence}` }; },
    update: async args => { posts.push({ ...args }); }, postEphemeral: async () => {},
  }, reactions: { add: async args => { reactions.push(args.name); } }, views: { open: async () => {} } };
  let options!: AdapterOptions;
  let adapter!: SlackAdapter;
  let release: (() => void) | undefined;
  let pauseStep: string | undefined;
  const checkpoint = async (step: string) => {
    if (step === pauseStep) await new Promise<void>(resolve => { release = resolve; });
  };
  const runtime = new Runtime(config, { run, log: (level, message) => logs.push(`${level} ${message}`),
    installGuard: (repository, directory) => { commands.push({ program: 'guard', args: [repository, directory] }); return join(directory, 'pre-push'); },
    checkpoint,
    socketMode: (store, supplied) => {
      options = supplied;
      adapter = new SlackAdapter(client, store, supplied);
      return { adapter, socket: new EventEmitter(), app: {
        start: async () => { lifecycle.push('connected'); }, stop: async () => { lifecycle.push('disconnected'); },
      } };
    },
  });
  runtimes.push(runtime);
  return { root, config, file, control, commands, posts, reactions, lifecycle, logs, runtime,
    adapter: () => adapter, options: () => options,
    addReport: (type = 'question', outcome?: string) => { messages.push({ id: 'report', sequence: 1, type, body: 'Choose a color',
      payload: JSON.stringify({ dispatchId: 'dispatch', taskId: 'task', outcome }) }); unread = true; },
    pause: (step: string) => { pauseStep = step; }, release: () => release?.(), paused: () => !!release,
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
  expect(f.commands.filter(command => command.args[1] === 'worker-show').length).toBeGreaterThan(1);
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
