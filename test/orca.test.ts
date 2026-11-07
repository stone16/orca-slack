import { expect, it, vi } from 'vitest';
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => execute }));
import { CliOrca, OrcaError, parseEnvelope } from '../src/orca.js';
it('uses the last complete JSON object after keepalives, including pretty JSON and escaped braces', () => {
  const output = '{"_keepalive":true}\n' + JSON.stringify({ ok: true, result: { body: 'a " } b', nested: { x: 1 } } }, null, 2);
  expect(parseEnvelope(output)).toEqual({ ok: true, result: { body: 'a " } b', nested: { x: 1 } } });
});
it('rejects incomplete output and preserves failed envelopes', () => {
  expect(() => parseEnvelope('{"_keepalive":true}\n{"ok":')).toThrow();
  expect(parseEnvelope('{"ok":false,"error":{"message":"no"}}').ok).toBe(false);
});

it('executes argument arrays without a shell and returns only the result', async () => {
  execute.mockResolvedValueOnce({ stdout: '{"ok":true,"result":{"dispatchId":"d1"}}' });
  expect(await new CliOrca().call('worker-start', ['--spec', 'literal $(bad) `bad`'])).toEqual({ dispatchId: 'd1' });
  expect(execute).toHaveBeenLastCalledWith('orca', ['orchestration', 'worker-start', '--spec', 'literal $(bad) `bad`', '--json'], expect.objectContaining({ timeout: 660000 }));
});
it('preserves nonzero start receipts even when their envelope says ok', async () => {
  execute.mockRejectedValueOnce({ stdout: '{"ok":true,"result":{"dispatchId":"d1","stage":"setup","lastError":"broken"}}' });
  const result = new CliOrca().call('worker-start').catch(error => error);
  expect(await result).toBeInstanceOf(OrcaError);
  expect((await result).receipt).toMatchObject({ dispatchId: 'd1', stage: 'setup' });
});
it('throws on ok:false and on a missing JSON receipt', async () => {
  execute.mockResolvedValueOnce({ stdout: '{"ok":false,"error":{"message":"denied"}}' });
  await expect(new CliOrca().call('reply')).rejects.toThrow('denied');
  execute.mockRejectedValueOnce(new Error('no CLI'));
  await expect(new CliOrca().call('reply')).rejects.toThrow('without a JSON receipt');
});
