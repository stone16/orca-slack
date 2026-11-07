import { expect, it } from 'vitest';
import { render, terminalTail } from '../src/render.js';
it('caps question buttons and preserves answer identity', () => {
  const result = render({ id: 'm1', type: 'question', body: 'Choose', payload: JSON.stringify({ options: ['a', 'b', 'c', 'd', 'e', 'f'] }) });
  const actions = result.blocks?.find(b => b.type === 'actions');
  expect(actions && 'elements' in actions && actions.elements).toHaveLength(5);
  expect(JSON.stringify(actions)).toContain('messageId');
  expect(result.text).toContain('自由输入');
});
it('supports options encoded in a JSON body and questions without options', () => {
  expect(JSON.stringify(render({ id: 'm', type: 'question', body: '{"question":"Choose","options":["yes"]}' }))).toContain('yes');
  expect(render({ id: 'm', type: 'question', body: 'What now?' }).text).toContain('线程');
});
it('includes failure, success, report paths and PR links', () => {
  expect(render({ id: 'm', type: 'worker_done', body: 'Done https://github.com/a/b/pull/1', payload: '{"outcome":"succeeded","reportPath":"/tmp/report"}' }).text).toContain('/tmp/report');
  expect(render({ id: 'm', type: 'worker_done', body: 'Broken', payload: '{"outcome":"failed"}' }).text).toContain('❌');
  expect(render({ id: 'm', type: 'escalation', body: 'Help' }).text).toContain('❌');
});
it('takes the last 40 lines and strips braille spinners', () => {
  const tail = terminalTail({ terminal: { tail: Array.from({ length: 50 }, (_, i) => `⠿line ${i}`) } });
  expect(tail.split('\n')).toHaveLength(40);
  expect(tail).toMatch(/^line 10/);
  expect(tail).not.toMatch(/[\u2800-\u28ff]/);
});
it('uses distinct action IDs and caps button text and values to Slack limits', () => {
  const result = render({ id: 'm', type: 'question', body: 'Choose', payload: JSON.stringify({ options: ['a'.repeat(100), 'b', 'c'.repeat(2100)] }) });
  const actions = result.blocks?.find(b => b.type === 'actions');
  const buttons = (actions && 'elements' in actions ? actions.elements : []) as { action_id: string; value: string; text: { text: string } }[];
  expect(buttons).toHaveLength(2); expect(new Set(buttons.map(b => b.action_id)).size).toBe(2);
  expect(buttons[0].text.text).toHaveLength(75);
  expect(buttons.every(b => b.value.length <= 2000)).toBe(true);
});
