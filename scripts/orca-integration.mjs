import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CliOrca, OrcaError, parseEnvelope } from '../dist/orca.js';
import { ReportLoop } from '../dist/report-loop.js';
import { Store } from '../dist/store.js';

const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const script = fileURLToPath(import.meta.url);
async function cli(args) {
  let stdout;
  try {
    ({ stdout } = await execute('orca', [...args, '--json'], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }));
  } catch (error) { stdout = error.stdout || ''; }
  const envelope = parseEnvelope(stdout);
  assert.equal(envelope.ok, true, `Orca ${args[0]} ${args[1]} succeeded (${envelope.error?.code || 'ok'})`);
  return envelope.result;
}
function save(root, name, value) {
  writeFileSync(join(root, name), JSON.stringify(value), { mode: 0o600 });
}
async function bridge(root) {
  const orca = new CliOrca();
  const state = {};
  const store = new Store(join(root, 'ledger.sqlite'));
  let settled = false;
  try {
    const created = await orca.call('run-create', ['--objective', 'Disposable Bridge core integration']);
    state.runId = created.run.id;
    save(root, 'state.json', state);
    const receipt = await orca.call('worker-start', ['--run', state.runId, '--worktree', 'current', '--agent', 'codex',
      '--spec', 'This is a disposable integration test. Do not edit files, use Slack or Linear, create Runs, or start helpers. Immediately send worker_done with outcome succeeded and this three-sentence body: Ran the trivial integration worker. BRIDGE_CORE_OK. Nothing remains.']);
    state.dispatchId = receipt.dispatchId;
    assert.ok(state.dispatchId, 'worker has an exact Dispatch');
    save(root, 'state.json', state);
    const sent = [];
    let peekIds = [];
    let consumeIds = [];
    const loop = new ReportLoop(orca, store, state.runId, async report => { sent.push(report); }, step => {
      if (step === 'after-peek-persist') peekIds = store.reports(state.runId).map(row => row.id);
      if (step === 'after-consume-persist') consumeIds = store.reports(state.runId).map(row => row.id);
    });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const unread = await orca.call('check', ['--run', state.runId, '--peek', '--wait', '--timeout-ms', '15000']);
      if (!unread.messages?.length) continue;
      await loop.poll();
      if (sent.some(row => row.type === 'worker_done' && row.body?.includes('BRIDGE_CORE_OK'))) break;
    }
    const report = sent.find(row => row.type === 'worker_done' && row.body?.includes('BRIDGE_CORE_OK'));
    assert.ok(report, 'worker report reached the local delivery sink');
    const payload = JSON.parse(report.payload);
    assert.equal(payload.dispatchId, state.dispatchId, 'report belongs to the created Dispatch');
    assert.equal(payload.outcome, 'succeeded', 'worker succeeded');
    settled = true;
    assert.ok(peekIds.includes(report.id), 'peek was persisted');
    assert.ok(consumeIds.includes(report.id), 'consuming batch was persisted');
    assert.ok(Number.isSafeInteger(report.sequence), 'inbox sequence was persisted');
    assert.equal((await orca.peek(state.runId)).length, 0, 'report was consumed');
    assert.equal((await loop.recover()).state, 'complete', 'startup coverage is complete');
    assert.equal(sent.filter(row => row.id === report.id).length, 1, 'report was sent once');
    state.evidence = { runId: state.runId, dispatchId: state.dispatchId, peekIds, consumeIds,
      sentIds: sent.map(row => row.id), sequence: report.sequence, coverage: store.coverage(state.runId).state };
  } catch (error) {
    if (error instanceof OrcaError && error.receipt.dispatchId) state.dispatchId = error.receipt.dispatchId;
    state.error = error instanceof OrcaError ? 'Orca command failed; inspect the disposable terminal before removing it'
      : String(error.message).replaceAll(root, '<temporary>');
  } finally {
    try {
      if (state.dispatchId) {
        if (!settled) await orca.call('worker-stop', ['--dispatch', state.dispatchId]);
        await orca.call('worker-release', ['--dispatch', state.dispatchId]);
        state.workerReleased = true;
      }
    } catch { state.error = 'Disposable worker cleanup failed'; }
    store.close();
    save(root, 'finished.json', state);
  }
}
function rows(value, key) {
  const result = Array.isArray(value) ? value : value[key];
  assert.ok(Array.isArray(result), `Orca returned ${key}`);
  assert.ok(!value.truncated, `${key} inventory is not truncated`);
  return result;
}
async function inventory() {
  const repos = rows(await cli(['repo', 'list']), 'repos').map(row => row.id).sort();
  const worktrees = rows(await cli(['worktree', 'list', '--limit', '10000']), 'worktrees').map(row => row.id).sort();
  return { repos, worktrees };
}
async function drive() {
  const before = await inventory();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-integration-')));
  let registered;
  let terminal;
  let result;
  let clean = false;
  try {
    await execute('git', ['init', '-b', 'main', root]);
    writeFileSync(join(root, 'README.md'), '# Disposable integration repository\n');
    await execute('git', ['-C', root, 'add', 'README.md']);
    await execute('git', ['-C', root, '-c', 'user.name=Integration Test', '-c', 'user.email=integration@example.invalid',
      'commit', '-m', 'test: seed disposable integration repository']);
    const repo = await cli(['repo', 'add', '--path', root]);
    registered = repo.repo.id;
    assert.ok(registered, 'disposable repository registered');
    const trees = rows(await cli(['worktree', 'list', '--limit', '10000']), 'worktrees').filter(row => row.repoId === registered);
    assert.equal(trees.length, 1, 'one exact disposable workspace');
    const selector = `id:${trees[0].id}`;
    await cli(['terminal', 'create', '--worktree', selector,
      '--title', 'bridge-core-integration', '--command', `${quote(process.execPath)} ${quote(script)} --bridge ${quote(root)}`]);
    const terminals = rows(await cli(['terminal', 'list', '--worktree', selector]), 'terminals');
    assert.equal(terminals.length, 1, 'one disposable Bridge terminal');
    terminal = terminals[0].handle;
    assert.ok(terminal, 'disposable Bridge terminal created');
    const deadline = Date.now() + 240_000;
    while (!existsSync(join(root, 'finished.json')) && Date.now() < deadline) await pause(250);
    assert.ok(existsSync(join(root, 'finished.json')), 'disposable Bridge completed before deadline');
    result = JSON.parse(readFileSync(join(root, 'finished.json'), 'utf8'));
    assert.ok(!result.error, result.error);
    assert.equal(result.workerReleased, true, 'worker resource released');
    clean = true;
  } finally {
    if (terminal && (clean || !existsSync(join(root, 'state.json')))) {
      await cli(['terminal', 'close', '--terminal', terminal]);
    }
    if (registered && (clean || !terminal)) {
      await cli(['project', 'setup-delete', '--setup', registered, '--host', 'local', '--force']);
    }
    if (clean || !terminal) rmSync(root, { recursive: true });
    if (!clean && terminal) console.error('Integration did not finish cleanly; disposable resources retained for exact recovery.');
  }
  const after = await inventory();
  assert.deepEqual(after, before, 'repository and worktree membership unchanged');
  const hash = ids => createHash('sha256').update(JSON.stringify(ids)).digest('hex');
  console.log(JSON.stringify({ verdict: 'verified', ...result.evidence, cleanup: {
    workerReleased: result.workerReleased, terminalClosed: true, repositoryRemoved: true, temporaryFilesRemoved: !existsSync(root),
    repos: { before: before.repos.length, after: after.repos.length, idsSha256: hash(after.repos) },
    worktrees: { before: before.worktrees.length, after: after.worktrees.length, idsSha256: hash(after.worktrees) },
    auditHistoryRetained: true,
  } }, null, 2));
}
if (process.argv[2] === '--bridge') await bridge(resolve(process.argv[3]));
else await drive();
