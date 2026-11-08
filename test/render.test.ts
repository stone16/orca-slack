import { expect, test } from 'vitest';
import { renderDecision, renderResult, renderStatus, type StatusView, type WorkState } from '../src/render.js';

const view: StatusView = {
  threadId: 'thread', title: 'Export orders', state: 'implementing', next: 'Waiting for the lead',
  linear: { label: 'ENG-12', url: 'https://linear.app/example/issue/ENG-12' },
  worktrees: [{ id: 'web', repository: 'example/web', branch: 'feat/export', state: 'implementing',
    hasCommits: false, agentActive: true }],
};
function buttons(post: ReturnType<typeof renderStatus>) {
  return post.blocks.flatMap(block => block.type === 'actions' ? block.elements : []);
}
const states: [WorkState, string, string[]][] = [
  ['classifying', '判断中', ['switch-repository', 'stop']],
  ['discussing', '聊需求', ['switch-repository', 'stop']],
  ['implementing', '实现中', ['switch-repository', 'stop']],
  ['waiting', '等你决定', ['stop']],
  ['pr-open', 'PR 已开', ['stop']],
  ['awaiting-verification', '已合并待验证', []],
  ['cleaned', '已清理', []],
  ['failed', '失败', []],
  ['stopped', '已停止', []],
  ['unknown', '状态未知', ['stop']],
  ['interrupted', 'lead 已中断', ['stop']],
];

test.each(states)('status content and button matrix for %s', (state, label, actions) => {
  const post = renderStatus({ ...view, state, worktrees: [{ ...view.worktrees[0], state }] });
  const sections = post.blocks.filter(block => block.type === 'section').map(block => block.text.text);
  expect(sections[0]).toContain('Export orders');
  expect(sections[0]).toContain(label);
  expect(sections.filter(text => text.startsWith('• '))).toEqual([`• example/web · feat/export · ${label}`]);
  expect(sections.join('\n')).toContain('<https://linear.app/example/issue/ENG-12|ENG-12>');
  expect(sections.join('\n')).toContain('Waiting for the lead');
  expect(buttons(post).map(button => button.action_id)).toEqual(actions);
  expect(post.text).not.toContain('<@');
});

test('each worktree gets one row with its repository, branch, state, and PR link', () => {
  const post = renderStatus({ ...view, state: 'pr-open', worktrees: [
    { ...view.worktrees[0], hasCommits: true, state: 'pr-open',
      pullRequest: { number: 12, url: 'https://github.com/example/web/pull/12', state: 'open' } },
    { id: 'api', repository: 'example/api', branch: 'feat/export-api', state: 'unknown', hasCommits: true,
      agentActive: false, pullRequest: { number: 13, url: 'https://github.com/example/api/pull/13', state: 'merged' } },
  ] });
  expect(post.blocks.filter(block => block.type === 'section' && block.text.text.startsWith('• ')))
    .toMatchObject([
      { text: { text: '• example/web · feat/export · PR 已开 · <https://github.com/example/web/pull/12|PR #12>' } },
      { text: { text: '• example/api · feat/export-api · 状态未知 · <https://github.com/example/api/pull/13|PR #13>' } },
    ]);
});

test.each(['classifying', 'discussing', 'implementing'] as const)(
  'switch repository in %s requires no commits and no PR on any worktree', state => {
    for (const tree of [
      { ...view.worktrees[0], hasCommits: true },
      { ...view.worktrees[0], pullRequest: { number: 12, url: 'https://github.com/example/web/pull/12', state: 'closed' as const } },
    ]) {
      const post = renderStatus({ ...view, state, worktrees: [view.worktrees[0], { ...tree, id: 'other' }] });
      expect(buttons(post).map(button => button.action_id)).toEqual(['stop']);
    }
  });

test.each([
  { active: false, pr: 'merged', expected: ['cleanup'] },
  { active: true, pr: 'merged', expected: [] },
  { active: false, pr: 'open', expected: [] },
  { active: false, pr: 'closed', expected: [] },
  { active: false, pr: undefined, expected: [] },
] as const)('cleanup matrix with active=$active and pr=$pr', ({ active, pr, expected }) => {
  const tree = { ...view.worktrees[0], agentActive: active, pullRequest: pr ? {
    number: 12, url: 'https://github.com/example/web/pull/12', state: pr,
  } : undefined };
  expect(buttons(renderStatus({ ...view, state: 'awaiting-verification', worktrees: [tree] }))
    .map(button => button.action_id)).toEqual(expected);
  expect(buttons(renderStatus({ ...view, state: 'awaiting-verification', worktrees: [tree,
    { ...view.worktrees[0], id: 'child', agentActive: true }] }))).toEqual([]);
});

test('cleanup needs at least one merged PR and no remaining unmerged PR', () => {
  const merged = { ...view.worktrees[0], agentActive: false, pullRequest: {
    number: 12, url: 'https://github.com/example/web/pull/12', state: 'merged' as const,
  } };
  expect(buttons(renderStatus({ ...view, state: 'awaiting-verification', worktrees: [] }))).toEqual([]);
  for (const state of ['open', 'closed'] as const) {
    const child = { ...merged, id: 'child', pullRequest: { ...merged.pullRequest, state } };
    expect(buttons(renderStatus({ ...view, state: 'awaiting-verification', worktrees: [merged, child] }))).toEqual([]);
  }
});

test('decision options include resume, one approval, and two more rounds, and mention the owner', () => {
  const post = renderDecision({ threadId: 'thread', id: 'question', owner: 'U1', question: 'Choose the next step',
    options: ['恢复', '批准一次', '再来 2 轮'] });
  expect(post.text).toContain('<@U1>');
  expect(buttons(post).map(button => [button.text.text, JSON.parse(button.value)])).toEqual([
    ['恢复', { threadId: 'thread', decisionId: 'question', option: '恢复' }],
    ['批准一次', { threadId: 'thread', decisionId: 'question', option: '批准一次' }],
    ['再来 2 轮', { threadId: 'thread', decisionId: 'question', option: '再来 2 轮' }],
  ]);
});

test('answered decisions replace buttons with the selected option and answering user', () => {
  const post = renderDecision({ threadId: 'thread', id: 'question', owner: 'U1', question: 'Continue?',
    options: ['Continue', 'Pause'], answer: 'Continue', answeredBy: 'U1' });
  expect(buttons(post)).toEqual([]);
  expect(post.blocks).toContainEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: '已选择 Continue · <@U1>' }] });
});

test('a taken status action becomes muted text naming the user who clicked it', () => {
  const post = renderStatus({ ...view, acted: { actionId: 'switch-repository', user: 'U1' } });
  expect(buttons(post).map(button => button.action_id)).toEqual(['stop']);
  expect(post.blocks).toContainEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: '换 repo · 已点击 <@U1>' }] });
});

test.each(['succeeded', 'failed'] as const)('result button matrix for %s', outcome => {
  const post = renderResult({ threadId: 'thread', id: 'result', outcome, text: 'The export checks finished',
    owner: 'U1', needsAttention: outcome === 'failed' });
  expect(buttons(post).map(button => [button.action_id, button.text.text])).toEqual(outcome === 'failed'
    ? [['retry', '重试'], ['log-tail', '查看日志尾部']] : []);
  expect(post.text.includes('<@U1>')).toBe(outcome === 'failed');
});

test('rendering escapes Slack control characters and rejects unsafe link schemes', () => {
  const post = renderStatus({ ...view, title: 'Export <@U2> & <@everyone>',
    worktrees: [{ ...view.worktrees[0], repository: '<!channel>', branch: '<@U2>' }] });
  expect(JSON.stringify(post.blocks)).not.toContain('<@U2>');
  expect(JSON.stringify(post.blocks)).toContain('&lt;!channel&gt;');
  expect(() => renderStatus({ ...view, linear: { label: 'ENG-12', url: 'javascript:alert(1)' } })).toThrow('Invalid link');
});
