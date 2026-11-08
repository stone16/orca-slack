import { expect, test } from 'vitest';
import { CliOrca, parseEnvelope } from '../src/orca.js';

test('Orca client peeks, consumes once, and reads full history with sequences through the command boundary', async () => {
  const commands: string[][] = [];
  const message = { id: 'msg-1', type: 'worker_done', body: 'Ready', payload: '{"outcome":"succeeded"}' };
  const orca = new CliOrca(async args => {
    commands.push(args);
    return { stdout: JSON.stringify({ ok: true, result: args[1] === 'inbox'
      ? { count: 1, messages: [{ ...message, sequence: 7, read: 1 }] }
      : { messages: [message] } }) };
  });
  expect(await orca.peek('run-1')).toEqual([message]);
  expect(await orca.consume('run-1')).toEqual([message]);
  expect(await orca.inbox('run-1')).toEqual({ count: 1, messages: [{ ...message, sequence: 7, read: 1 }] });
  expect(commands).toEqual([
    ['orchestration', 'check', '--run', 'run-1', '--peek', '--json', '--full'],
    ['orchestration', 'check', '--run', 'run-1', '--json', '--full'],
    ['orchestration', 'inbox', '--terminal', 'run:run-1', '--limit', '1000', '--json', '--full'],
  ]);
});

test('Orca transport retains failed launch receipts and rejects incomplete output', async () => {
  const orca = new CliOrca(async () => ({ failed: true, stdout: JSON.stringify({ ok: false,
    result: { dispatchId: 'dispatch-1', failedStage: 'launch', lastError: 'refused' } }) }));
  await expect(orca.call('worker-start')).rejects.toMatchObject({ receipt: { dispatchId: 'dispatch-1' } });
  expect(() => parseEnvelope('not JSON')).toThrow('no complete JSON envelope');
  expect(parseEnvelope('{"_keepalive":true}\n{"ok":true,"result":{"body":"quoted } brace"}}\n{"_heartbeat":true}'))
    .toEqual({ ok: true, result: { body: 'quoted } brace' } });
});

test.each([
  { count: 1, messages: [{ id: 'm', type: 'status' }] },
  { count: 0, messages: [{ id: 'm', type: 'status', sequence: 1 }] },
  { count: 1, messages: [{ id: 'm', type: 'status', sequence: -1 }] },
])('Orca rejects malformed inbox history %j before reconciliation', async result => {
  const orca = new CliOrca(async () => ({ stdout: JSON.stringify({ ok: true, result }) }));
  await expect(orca.inbox('run')).rejects.toThrow(/Invalid/);
});
