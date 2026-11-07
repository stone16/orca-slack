import { App, SocketModeReceiver, LogLevel, type Logger } from '@slack/bolt';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { CliOrca, type Orca } from './orca.js';
import { Store } from './store.js';
import { Bridge, registerHandlers } from './slack.js';
import { ReportLoop } from './report-loop.js';
import { post, type Slack } from './render.js';

export async function ensureRun(orca: Orca, store: Store, host: string): Promise<string> {
  const saved = store.getMeta('run_id');
  if (saved) return saved;
  const result = await orca.call<{ run: { id: string } }>('run-create', ['--objective', `orca-slack bridge ${host}`]);
  if (!result.run?.id) throw new Error('Invalid run-create receipt');
  store.setMeta('run_id', result.run.id);
  return result.run.id;
}
export function logging(secrets: string[]) {
  const redact = (text: string) => secrets.filter(Boolean).reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text);
  const log = (event: string, error?: unknown) => console.log(JSON.stringify({ time: new Date().toISOString(), event,
    ...(error === undefined ? {} : { detail: redact(error instanceof Error ? error.message : String(error)) }) }));
  const logger: Logger = {
    debug: () => {}, info: (...args) => log('slack_info', args.join(' ')),
    warn: (...args) => log('slack_warn', args.join(' ')), error: (...args) => log('slack_error', args.join(' ')),
    setLevel: () => {}, getLevel: () => LogLevel.INFO, setName: () => {},
  };
  return { log, logger, redact };
}
export function createSlackApp(token: string, appToken: string, logger: Logger, proxy?: string) {
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
  const receiver = new SocketModeReceiver({ appToken, logger });
  if (agent) {
    // Bolt 4's receiver omits clientOptions; retain its event adapter on a proxy-configured Socket Mode client.
    const original = receiver.client;
    receiver.client = Reflect.construct(original.constructor, [{ appToken, logger, clientOptions: { agent } }]);
    for (const listener of original.listeners('slack_event')) receiver.client.on('slack_event', listener);
  }
  const app = new App({ token, receiver, socketMode: true, logger, clientOptions: { ...(agent ? { agent } : {}),
    retryConfig: { retries: 2 }, timeout: 10_000 }, tokenVerificationEnabled: false });
  return { app, socket: receiver.client };
}
export function watchConnection(socket: { on(event: string, listener: () => void): unknown }, fatal: (error: unknown) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disconnected = () => { timer ??= setTimeout(() => fatal(new Error('Slack disconnected for 60 seconds')), 60_000); };
  socket.on('connecting', disconnected);
  socket.on('close', disconnected);
  socket.on('reconnecting', disconnected);
  socket.on('disconnected', disconnected);
  socket.on('connected', () => { clearTimeout(timer); timer = undefined; });
  return () => clearTimeout(timer);
}
export function fatalHandler(slack: Slack, opsChannel: string, log: (event: string, error?: unknown) => void,
  redact: (text: string) => string, exit: (code: number) => void = process.exit) {
  let exiting = false;
  return (error: unknown) => {
    if (exiting) return;
    exiting = true;
    log('fatal', error);
    // Exit even if Slack is unreachable; launchd must be able to restart a broken connection.
    const timer = setTimeout(() => exit(1), 12_000);
    void post(slack, opsChannel, undefined, { text: `orca-slack fatal: ${redact(error instanceof Error ? error.message : String(error))}` })
      .catch(() => log('ops_notification_failed')).finally(() => { clearTimeout(timer); exit(1); });
  };
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === '--check-config') {
    if (!args[1] || args.length !== 2) throw new Error('Usage: --check-config <file>');
    console.log(JSON.stringify(loadConfig(args[1]), null, 2));
    return;
  }
  if (args.length) throw new Error('Use ORCA_SLACK_CONFIG or --check-config <file>');
  process.umask(0o077);
  const config = loadConfig(process.env.ORCA_SLACK_CONFIG ?? 'config.json');
  const token = process.env.SLACK_BOT_TOKEN, appToken = process.env.SLACK_APP_TOKEN;
  if (!token || !appToken) throw new Error('SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required');
  const { log, logger, redact } = logging([token, appToken, process.env.HTTPS_PROXY ?? '']);
  const { app, socket } = createSlackApp(token, appToken, logger, process.env.HTTPS_PROXY);
  const fatal = fatalHandler(app.client, config.opsChannel, log, redact);
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  app.error(async error => { fatal(error); });
  socket.on('error', (error: unknown) => log('socket_error', error));
  watchConnection(socket, fatal);
  const heartbeat = () => {
    mkdirSync(dirname(config.heartbeatFile), { recursive: true });
    writeFileSync(config.heartbeatFile, new Date().toISOString() + '\n', { mode: 0o600 });
  };
  try {
    mkdirSync(dirname(config.dbFile), { recursive: true });
    const store = new Store(config.dbFile);
    const orca = new CliOrca();
    const runId = await ensureRun(orca, store, hostname());
    const bridge = new Bridge(orca, app.client, store, config, runId);
    registerHandlers(app, bridge, fatal);
    heartbeat();
    setInterval(heartbeat, 30_000);
    await app.start();
    log('started', `run ${runId}`);
    const loop = new ReportLoop(orca, app.client, store, config, runId, heartbeat, log, () => bridge.waitForStarts());
    void loop.run().catch(fatal);
  } catch (error) { fatal(error); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    const { log } = logging([process.env.SLACK_BOT_TOKEN ?? '', process.env.SLACK_APP_TOKEN ?? '', process.env.HTTPS_PROXY ?? '']);
    log('startup_error', error);
    process.exitCode = 1;
  });
}
