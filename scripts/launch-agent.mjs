import { execFileSync } from 'node:child_process';
import { accessSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultCheckout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launchctl = args => execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
function settings(options = {}) {
  const label = options.label ?? 'dev.orca-slack.bridge';
  if (!/^[a-z][a-z0-9.-]+$/.test(label)) throw new Error('Invalid LaunchAgent label');
  const checkout = resolve(options.checkout ?? defaultCheckout);
  const agentDirectory = options.agentDirectory ?? join(homedir(), 'Library', 'LaunchAgents');
  return { label, checkout, agentDirectory, logDirectory: options.logDirectory ?? join(checkout, 'data', 'logs'),
    config: resolve(checkout, options.config ?? process.env.BRIDGE_CONFIG ?? 'config.local.json'),
    path: options.path ?? process.env.PATH, domain: `gui/${process.getuid()}`, plist: join(agentDirectory, `${label}.plist`) };
}
export function renderLaunchAgent(template, values) {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (typeof values[key] !== 'string' || !values[key]) throw new Error(`Missing template value ${key}`);
    return escape(values[key]);
  });
}
function unload(current, run) {
  let loaded = false;
  try { run(['print', `${current.domain}/${current.label}`]); loaded = true; }
  catch (error) { if (error.status !== 113) throw error; }
  if (loaded) run(['bootout', `${current.domain}/${current.label}`]);
}
export function install(options, run = launchctl) {
  const current = settings(options);
  for (const file of [join(current.checkout, 'dist', 'main.js'), join(current.checkout, '.env'), current.config]) accessSync(file);
  const rendered = renderLaunchAgent(readFileSync(join(current.checkout, 'deploy', 'launch-agent.plist.template'), 'utf8'), {
    LABEL: current.label, NODE: process.execPath, ENV_FILE: join(current.checkout, '.env'), ENTRY_POINT: join(current.checkout, 'dist', 'main.js'),
    CHECKOUT: current.checkout, PATH: current.path, CONFIG: current.config,
    STDOUT: join(current.logDirectory, 'bridge.log'), STDERR: join(current.logDirectory, 'bridge-error.log'),
  });
  mkdirSync(current.agentDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(current.logDirectory, { recursive: true, mode: 0o700 });
  unload(current, run);
  writeFileSync(current.plist, rendered, { mode: 0o600 });
  run(['bootstrap', current.domain, current.plist]);
  return current.plist;
}
export function uninstall(options, run = launchctl) {
  const current = settings(options);
  unload(current, run);
  try { unlinkSync(current.plist); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action, label] = process.argv.slice(2);
    if (action === 'install') { install({ label }); console.log(`Loaded LaunchAgent ${label ?? 'dev.orca-slack.bridge'}`); }
    else if (action === 'uninstall') { uninstall({ label }); console.log(`Removed LaunchAgent ${label ?? 'dev.orca-slack.bridge'}`); }
    else throw new Error('Usage: node scripts/launch-agent.mjs install|uninstall [label]');
  } catch (error) {
    console.error(error.message.replaceAll(defaultCheckout, '[checkout]'));
    process.exitCode = 1;
  }
}
