import { expect, it } from 'vitest';
import { route } from '../src/route.js';
const channel = { repo: 'name:repo', agent: 'codex', model: 'model', effort: 'high' };
it('strips only the bot mention and preserves the task and routing', () => {
  expect(route(channel, '<@UBOT> fix <@UOTHER> please', 'UBOT')).toEqual([
    '--spec', 'fix <@UOTHER> please', '--worktree', 'new-child', '--repo', 'name:repo',
    '--agent', 'codex', '--model', 'model', '--effort', 'high',
  ]);
});
it('refuses an empty task', () => expect(() => route(channel, '<@UBOT>  ', 'UBOT')).toThrow(/empty/i));
it('supports the two-argument route contract with a leading mention', () => {
  expect(route(channel, '<@UBOT> task')[1]).toBe('task');
});
