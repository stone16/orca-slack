import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { createSlackApp, ensureRun, fatalHandler, logging, watchConnection } from '../src/main.js';
import { Store } from '../src/store.js';
import { fakeSlack } from './helpers.js';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it('creates one run and reuses its durable ID', async () => {
  const store = new Store(':memory:');
  const orca = { call: vi.fn().mockResolvedValue({ run: { id: 'r1' } }) };
  expect(await ensureRun(orca, store, 'host')).toBe('r1');
  expect(await ensureRun(orca, store, 'host')).toBe('r1');
  expect(orca.call).toHaveBeenCalledExactlyOnceWith('run-create', ['--objective', 'orca-slack bridge host']);
  store.close();
});
it('constructs proxy clients without network and retains the Socket Mode event adapter', () => {
  const { logger } = logging([]);
  const plain = createSlackApp('fake-bot', 'fake-app', logger);
  const proxied = createSlackApp('fake-bot', 'fake-app', logger, 'http://localhost:8118');
  expect(plain.socket.listeners('slack_event')).toHaveLength(1);
  expect(proxied.socket.listeners('slack_event')).toHaveLength(1);
  type WebOptions = { axios: { defaults: { httpsAgent?: unknown } } };
  const webOptions = proxied.app.client as unknown as WebOptions;
  const socketOptions = proxied.socket as unknown as { webClientOptions: { agent: unknown }; webClient: WebOptions };
  expect(socketOptions.webClientOptions.agent).toBeDefined();
  expect(socketOptions.webClientOptions.agent).toBe(socketOptions.webClient.axios.defaults.httpsAgent);
  expect(webOptions.axios.defaults.httpsAgent).toBe(socketOptions.webClientOptions.agent);
});
it('allows reconnects within 60s but alerts once a connection remains down', async () => {
  vi.useFakeTimers();
  const socket = new EventEmitter(), fatal = vi.fn();
  const cleanup = watchConnection(socket, fatal);
  socket.emit('close'); await vi.advanceTimersByTimeAsync(59_000); socket.emit('connected');
  await vi.advanceTimersByTimeAsync(2000); expect(fatal).not.toHaveBeenCalled();
  socket.emit('reconnecting'); await vi.advanceTimersByTimeAsync(30_000); socket.emit('reconnecting');
  await vi.advanceTimersByTimeAsync(30_000); expect(fatal).toHaveBeenCalledTimes(1);
  cleanup();
});
it('redacts credentials in structured logs', () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const { log, logger } = logging(['secret-bot', 'secret-app']);
  log('test', new Error('secret-bot secret-app')); logger.error('secret-bot');
  for (const [line] of output.mock.calls) {
    expect(() => JSON.parse(line)).not.toThrow(); expect(line).not.toContain('secret-');
  }
});
it('sends one fatal ops alert then exits, even with competing errors', async () => {
  const slack = fakeSlack(), exit = vi.fn(), log = vi.fn();
  const fatal = fatalHandler(slack.client, 'COPS', log, text => text, exit);
  fatal(new Error('boom')); fatal(new Error('second'));
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
});
it('exits after a bounded wait if the fatal alert cannot reach Slack', async () => {
  vi.useFakeTimers();
  const slack = fakeSlack(), exit = vi.fn(); slack.chat.postMessage.mockImplementation(() => new Promise(() => {}));
  fatalHandler(slack.client, 'COPS', vi.fn(), text => text, exit)(new Error('offline'));
  await vi.advanceTimersByTimeAsync(12_000); expect(exit).toHaveBeenCalledWith(1);
});
