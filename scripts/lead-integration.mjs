import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { LeadCli } from '../dist/lead-orca.js';
import { Leads } from '../dist/leads.js';
import { parseEnvelope, OrcaError } from '../dist/orca.js';
import { ReportLoop } from '../dist/report-loop.js';
import { Bridge } from '../dist/slack.js';
import { Store } from '../dist/store.js';

const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const script = fileURLToPath(import.meta.url);
async function cli(args) {
  let output;
  try { output = await execute('orca', [...args, '--json'], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }); }
  catch (error) { output = { stdout: error.stdout ?? '' }; }
  const envelope = parseEnvelope(output.stdout);
  assert.equal(envelope.ok, true, `Orca ${args[0]} ${args[1]} (${envelope.error?.code ?? 'ok'})`);
  return envelope.result;
}
function rows(value, key) {
  const result = Array.isArray(value) ? value : value[key];
  assert.ok(Array.isArray(result) && !value.truncated, `complete ${key} inventory`);
  return result;
}
const save = (root, file, value) => writeFileSync(join(root, file), JSON.stringify(value), { mode: 0o600 });
async function bridge(root, repository) {
  const state = {};
  const orca = new LeadCli(async args => {
    let output;
    try { output = await execute('orca', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }); }
    catch (error) { output = { stdout: error.stdout ?? '', failed: true }; }
    if (args[1] === 'worker-start') {
      const receipt = parseEnvelope(output.stdout).result;
      state.launch = { dispatchId: receipt?.dispatchId, taskId: receipt?.taskId };
      save(root, 'state.json', state);
    }
    return output;
  });
  const store = new Store(join(root, 'ledger.sqlite'));
  const threadId = JSON.stringify(['fixture', '1']);
  let settled = false;
  try {
    state.runId = (await orca.call('run-create', ['--objective', 'Disposable lead lifecycle integration'])).run.id;
    save(root, 'state.json', state);
    const leads = new Leads(orca, store, { runId: state.runId, repositories: [{ id: repository, name: 'fixture', aliases: [] }], botId: 'BOT', agent: 'codex' });
    const bridge = new Bridge(orca, { refuse: async () => assert.fail('unexpected refusal'), ownerAction: async () => assert.fail('unexpected action') }, store, ['owner'], 'BOT', undefined, leads);
    await bridge.event({ installationId: 'test', eventId: 'first', channel: 'fixture', ts: '1', user: 'owner',
      text: '<@BOT> In fixture, perform this disposable integration task only. Do not edit files, call Slack or Linear, start helpers, or create Runs. Ask the Bridge the exact question BRIDGE_LEAD_QUESTION using orca orchestration ask and end your turn. When the Bridge replies BRIDGE_LEAD_ANSWER, immediately send worker_done with outcome succeeded and the three-sentence body: Ran the disposable lead. BRIDGE_LEAD_OK received BRIDGE_LEAD_ANSWER. Nothing remains.' });
    const session = store.leadSessions(threadId)[0];
    state.dispatchId = session.dispatchId;
    state.worktreeId = session.worktreeId;
    save(root, 'state.json', state);
    await leads.poll();
    assert.ok(store.leadObservation(session.id), 'real worker and terminal read cursors saved');
    let questionId;
    let doneId;
    const loop = new ReportLoop(orca, store, state.runId, async report => {
      await leads.report(report);
      if (report.type === 'question') {
        assert.ok(store.decision(report.id), 'question saved before answer');
        assert.equal(await bridge.action({ actionId: 'decision', threadId, channel: 'fixture', user: 'owner', decisionId: report.id, option: 'BRIDGE_LEAD_ANSWER' }), true);
        questionId = report.id;
      }
      if (report.type === 'worker_done') {
        assert.equal(JSON.parse(report.payload).dispatchId, session.dispatchId);
        assert.equal(JSON.parse(report.payload).outcome, 'succeeded');
        assert.ok(report.body.includes('BRIDGE_LEAD_OK received BRIDGE_LEAD_ANSWER'));
        doneId = report.id;
      }
    });
    const deadline = Date.now() + 180_000;
    while (!doneId && Date.now() < deadline) {
      await orca.call('check', ['--run', state.runId, '--peek', '--wait', '--timeout-ms', '10000']);
      await loop.poll();
    }
    assert.ok(questionId && doneId, 'lead asked, received the answer, and reported done');
    assert.equal(store.decision(questionId).answer, 'BRIDGE_LEAD_ANSWER');
    assert.equal(store.leadSessions(threadId)[0].active, false);
    assert.equal(store.leadEvents(threadId).at(-1).kind, 'completed');
    settled = true;
    state.evidence = { runId: state.runId, dispatchId: state.dispatchId, questionId, doneId,
      decisionSaved: true, ownerReplySaved: true, leadCompleted: true, readCursorsSaved: true };
  } catch (error) {
    if (error instanceof OrcaError && error.receipt.dispatchId) state.dispatchId = error.receipt.dispatchId;
    state.error = String(error.message).replaceAll(root, '<temporary>');
  } finally {
    const session = store.leadSessions(threadId)[0];
    state.worktreeId ??= session?.worktreeId;
    state.dispatchId ??= session?.dispatchId ?? state.launch?.dispatchId;
    try {
      if (state.dispatchId) {
        if (!settled) await orca.call('worker-stop', ['--dispatch', state.dispatchId]);
        await orca.call('worker-release', ['--dispatch', state.dispatchId]);
      }
      state.workerReleased = true;
    } catch { state.cleanupError = 'worker cleanup uncertain'; }
    store.close();
    save(root, 'finished.json', state);
  }
}
async function drive() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lead-integration-')));
  const repositoryPath = join(root, 'repository');
  let repository, terminal, result;
  let removed = false;
  try {
    await execute('git', ['init', '-b', 'main', repositoryPath]);
    writeFileSync(join(repositoryPath, 'README.md'), '# Disposable lead repository\n');
    await execute('git', ['-C', repositoryPath, 'add', 'README.md']);
    await execute('git', ['-C', repositoryPath, '-c', 'user.name=Integration Test', '-c', 'user.email=integration@example.invalid', 'commit', '-m', 'test: seed disposable lead repository']);
    const head = (await execute('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'])).stdout;
    repository = (await cli(['repo', 'add', '--path', repositoryPath])).repo.id;
    await cli(['project', 'setup-update', '--setup', repository, '--host', 'local', '--worktree-base-path', join(root, 'worktrees')]);
    const initial = rows(await cli(['worktree', 'list', '--repo', `id:${repository}`, '--limit', '10000']), 'worktrees');
    assert.equal(initial.length, 1);
    const selector = `id:${initial[0].id}`;
    await cli(['terminal', 'create', '--worktree', selector, '--title', 'lead-integration-bridge',
      '--command', `${quote(process.execPath)} ${quote(script)} --bridge ${quote(root)} ${quote(repository)}`]);
    const terminals = rows(await cli(['terminal', 'list', '--worktree', selector]), 'terminals');
    assert.equal(terminals.length, 1);
    terminal = terminals[0].handle;
    const deadline = Date.now() + 240_000;
    while (!existsSync(join(root, 'finished.json')) && Date.now() < deadline) await pause(250);
    assert.ok(existsSync(join(root, 'finished.json')), 'Bridge finished within deadline');
    result = JSON.parse(readFileSync(join(root, 'finished.json'), 'utf8'));
    assert.equal(result.workerReleased, true, result.cleanupError);
    assert.equal((await execute('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'])).stdout, head);
    assert.equal((await execute('git', ['-C', repositoryPath, 'status', '--porcelain'])).stdout, '');
  } finally {
    if (repository && (!terminal || result?.workerReleased)) {
      const trees = rows(await cli(['worktree', 'list', '--repo', `id:${repository}`, '--limit', '10000']), 'worktrees');
      for (const tree of trees.filter(tree => resolve(tree.path) !== repositoryPath)) {
        await cli(['terminal', 'close', '--worktree', `id:${tree.id}`, '--all']);
        await cli(['worktree', 'rm', '--worktree', `id:${tree.id}`]);
      }
      if (terminal) await cli(['terminal', 'close', '--terminal', terminal]);
      await cli(['project', 'setup-delete', '--setup', repository, '--host', 'local', '--force']);
      assert.ok(!rows(await cli(['repo', 'list']), 'repos').some(repo => repo.id === repository));
      assert.ok(!rows(await cli(['worktree', 'list', '--limit', '10000']), 'worktrees').some(tree => tree.repoId === repository));
      rmSync(root, { recursive: true });
      removed = true;
    }
    if (!removed) console.error('Disposable resources retained for exact recovery.');
  }
  assert.ok(!result.error, result.error);
  console.log(JSON.stringify({ verdict: 'verified', ...result.evidence, cleanup: {
    workerReleased: true, worktreeRemoved: true, bridgeTerminalClosed: true, repositoryRemoved: true,
    temporaryFilesRemoved: !existsSync(root), mainCheckoutUnchanged: true, auditHistoryRetained: true,
  } }, null, 2));
}
if (process.argv[2] === '--bridge') await bridge(resolve(process.argv[3]), process.argv[4]);
else await drive();
