export type WorkState = 'classifying' | 'discussing' | 'implementing' | 'waiting' | 'pr-open' |
  'awaiting-verification' | 'cleaned' | 'failed' | 'stopped' | 'unknown' | 'interrupted';
export type StatusAction = 'switch-repository' | 'stop' | 'cleanup';
export interface StatusView {
  threadId: string; title: string; state: WorkState; next?: string;
  acted?: { actionId: 'switch-repository' | 'cleanup'; user: string };
  linear?: { label: string; url: string };
  worktrees: {
    id: string; repository: string; branch: string; state: WorkState; hasCommits: boolean; agentActive: boolean;
    pullRequest?: { number: number; url: string; state: 'open' | 'merged' | 'closed' };
  }[];
}
export interface DecisionView {
  threadId: string; id: string; owner: string; question: string; options: string[];
  answer?: string; answeredBy?: string;
}
export interface ResultView {
  threadId: string; id: string; outcome: 'succeeded' | 'failed'; text: string;
  owner: string; needsAttention?: boolean; retriedBy?: string;
}
type Text = { type: 'plain_text' | 'mrkdwn'; text: string };
export interface Button {
  type: 'button'; action_id: string; text: { type: 'plain_text'; text: string }; value: string;
}
type Block = { type: 'section'; text: Text } | { type: 'actions'; elements: Button[] } |
  { type: 'context'; elements: Text[] };
export interface SlackPost { text: string; blocks: Block[] }

const labels: Record<WorkState, string> = {
  classifying: '判断中', discussing: '聊需求', implementing: '实现中', waiting: '等你决定',
  'pr-open': 'PR 已开', 'awaiting-verification': '已合并待验证', cleaned: '已清理', failed: '失败',
  stopped: '已停止', unknown: '状态未知', interrupted: 'lead 已中断',
};
const active: WorkState[] = ['classifying', 'discussing', 'implementing', 'waiting', 'pr-open', 'unknown', 'interrupted'];
export function statusActions(view: StatusView): StatusAction[] {
  const actions: StatusAction[] = [];
  if (view.worktrees.length > 0 && ['classifying', 'discussing', 'implementing'].includes(view.state) &&
      view.worktrees.every(tree => !tree.hasCommits && !tree.pullRequest)) actions.push('switch-repository');
  if (active.includes(view.state)) actions.push('stop');
  if (view.state === 'awaiting-verification' && view.worktrees.every(tree => !tree.agentActive &&
      (!tree.pullRequest || tree.pullRequest.state === 'merged')) &&
      view.worktrees.some(tree => tree.pullRequest?.state === 'merged')) actions.push('cleanup');
  return actions.filter(action => action !== view.acted?.actionId);
}
export function escapeSlack(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function link(url: string, label: string): string {
  if (!/^https?:\/\//.test(url) || /[\s<>|]/.test(url)) throw new Error('Invalid link');
  return `<${escapeSlack(url)}|${escapeSlack(label).replaceAll('|', ' ')}>`;
}
function section(text: string): Block { return { type: 'section', text: { type: 'mrkdwn', text } }; }
function button(actionId: string, text: string, value: object): Button {
  const encoded = JSON.stringify(value);
  if (encoded.length > 2000) throw new Error('Button value exceeds Slack limit');
  return { type: 'button', action_id: actionId, text: { type: 'plain_text', text: text.slice(0, 75) }, value: encoded };
}
function chunks(text: string, limit: number, count: number): string[] {
  const parts: string[] = [];
  let part = '';
  for (const match of text.matchAll(/<[^>]*>|&(?:amp|lt|gt);|[\s\S]/gu)) {
    const unit = match[0].length < limit ? match[0] : '…';
    if (part.length + unit.length >= limit) {
      parts.push(part);
      if (parts.length === count) {
        parts[parts.length - 1] += '…';
        return parts;
      }
      part = '';
    }
    part += unit;
  }
  if (part) parts.push(part);
  return parts;
}
function post(lines: string[], buttons: Button[] = [], context?: string): SlackPost {
  const actions: Block[] = [];
  for (let i = 0; i < buttons.length && actions.length < (context ? 48 : 49); i += 25) {
    actions.push({ type: 'actions', elements: buttons.slice(i, i + 25) });
  }
  const blocks: Block[] = [];
  const budget = 50 - actions.length - (context ? 1 : 0);
  for (const line of lines) {
    if (blocks.length === budget) break;
    blocks.push(...chunks(line, 3000, budget - blocks.length).map(section));
  }
  blocks.push(...actions);
  if (context) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: chunks(context, 3000, 1)[0] }] });
  return { text: chunks([...lines, ...(context ? [context] : [])].join('\n'), 4000, 1)[0], blocks };
}
export function renderStatus(view: StatusView): SlackPost {
  const lines = [`${escapeSlack(view.title)} · ${labels[view.state]}`];
  if (view.linear) lines.push(link(view.linear.url, view.linear.label));
  for (const tree of view.worktrees) {
    lines.push(`• ${escapeSlack(tree.repository)} · ${escapeSlack(tree.branch)} · ${labels[tree.state]}` +
      (tree.pullRequest ? ` · ${link(tree.pullRequest.url, `PR #${tree.pullRequest.number}`)}` : ''));
  }
  if (view.next) lines.push(`下一步：${escapeSlack(view.next)}`);
  const names = { 'switch-repository': '换 repo', stop: '停止全部', cleanup: '线上已验证，清理' };
  return post(lines, statusActions(view).map(action => button(action, names[action], { threadId: view.threadId })),
    view.acted ? `${names[view.acted.actionId]} · 已点击 <@${view.acted.user}>` : undefined);
}
export function renderDecision(view: DecisionView): SlackPost {
  const context = view.answer === undefined ? undefined
    : `已选择 ${escapeSlack(view.answer)} · <@${view.answeredBy}>`;
  return post([`<@${view.owner}> ${escapeSlack(view.question)}`, '在线程回复可自由输入。'],
    view.answer === undefined ? view.options.map((option, index) => button(`decision_${index}`, option,
      { threadId: view.threadId, decisionId: view.id, option })) : [], context);
}
export function renderResult(view: ResultView): SlackPost {
  const text = `${view.outcome === 'failed' ? '❌' : '✅'} ${view.needsAttention ? `<@${view.owner}> ` : ''}${escapeSlack(view.text)}`;
  return post([text], view.outcome === 'failed' ? [
    ...(!view.retriedBy ? [button('retry', '重试', { threadId: view.threadId, resultId: view.id })] : []),
    button('log-tail', '查看日志尾部', { threadId: view.threadId, resultId: view.id }),
  ] : [], view.retriedBy ? `已重试 · <@${view.retriedBy}>` : undefined);
}
