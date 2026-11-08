import { expect, test } from 'vitest';
import { classify } from '../src/routing.js';

const repositories = [{ id: 'web', name: 'web', aliases: ['frontend'] }, { id: 'api', name: 'api', aliases: ['backend'] }];
test.each([
  ['Fix web login when the password is wrong', 'implement'],
  ['Can you fix web login to show the reason?', 'implement'],
  ['How do I fix the web login?', 'question'],
  ['web 的 session 在哪里配置？', 'question'],
  ['我想做个 web 导出功能', 'clarify'],
])('routes the intent of "%s" as %s', (text, intent) => {
  expect(classify('thread', text, repositories).intent).toBe(intent);
});

test('repository aliases match whole names and conflicting repositories remain unresolved', () => {
  expect(classify('thread', 'Fix FRONTEND login', repositories).repository).toBe('web');
  expect(classify('thread', 'Fix website login', repositories).repository).toBeNull();
  expect(classify('thread', 'Fix web and backend login', repositories)).toMatchObject({ repository: null, rule: 'ambiguous-repository' });
});
