import type { App } from '@slack/bolt';

export type Slack = Pick<App['client'], 'chat' | 'reactions'>;
export type SlackPost = { text: string; blocks?: Extract<Parameters<Slack['chat']['postMessage']>[0], { blocks: unknown }>['blocks'] };
export interface Message { id: string; type?: string; subject?: string; body?: string | null; payload?: string | null }
export function payload(message: Message): Record<string, unknown> {
  const value: unknown = message.payload ? JSON.parse(message.payload) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid orchestration payload');
  return value as Record<string, unknown>;
}
function bodyObject(message: Message): Record<string, unknown> {
  try { const value = JSON.parse(message.body ?? ''); return value && typeof value === 'object' ? value : {}; }
  catch { return {}; }
}
export function options(message: Message): string[] {
  let value = payload(message).options ?? bodyObject(message).options;
  if (typeof value === 'string') {
    const raw = value;
    try { value = JSON.parse(raw); } catch { value = raw.split(',').map(s => s.trim()); }
  }
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0) : [];
}
export function escapeSlack(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
export function render(message: Message): SlackPost {
  const p = payload(message);
  const body = message.body ?? message.subject ?? '';
  if (message.type === 'question') {
    const text = `❓ ${String(bodyObject(message).question ?? body)}\n在线程回复可自由输入。`;
    const buttons = options(message).slice(0, 5).filter(option => JSON.stringify({ messageId: message.id, option }).length <= 2000);
    return { text, blocks: [
      ...[text.slice(0, 3000), text.slice(3000, 3500)].filter(Boolean).map(part => ({
        type: 'section' as const, text: { type: 'plain_text' as const, text: part },
      })),
      ...(buttons.length ? [{ type: 'actions' as const, elements: buttons.map((option, index) => ({
        type: 'button' as const, action_id: `answer_${index}`, text: { type: 'plain_text' as const, text: option.trim().slice(0, 75) },
        value: JSON.stringify({ messageId: message.id, option }),
      })) }] : []),
    ] };
  }
  const icon = message.type === 'escalation' || p.outcome === 'failed' ? '❌' : message.type === 'worker_done' && p.outcome === 'succeeded' ? '✅' : 'ℹ️';
  const links = [p.reportPath, p.prUrl, p.prURL, p.pullRequestUrl].filter((v): v is string => typeof v === 'string' && !body.includes(v));
  return { text: `${icon} ${body}${links.length ? '\n' + links.join('\n') : ''}` };
}
export function dispatched(dispatchId: string, worktree: string, runId: string): SlackPost {
  const text = `派了：\`${dispatchId}\` · worktree \`${worktree}\` · run \`${runId}\``;
  return { text, blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: escapeSlack(text) } },
    { type: 'actions', elements: [{ type: 'button', action_id: 'stop', text: { type: 'plain_text', text: '⏹ 停止' }, value: JSON.stringify({ dispatchId }) }] },
  ] };
}
export function stopped(user: string): SlackPost { return { text: `已停止 by <@${user}>` }; }
export function terminalTail(receipt: { terminal?: { tail?: string[] } }): string {
  return (receipt.terminal?.tail ?? []).join('\n').replace(/[\u2800-\u28ff]/g, '').split('\n').slice(-40).join('\n');
}
export async function post(slack: Slack, channel: string, threadTs: string | undefined, message: SlackPost): Promise<string> {
  // Slack truncates oversized messages; split text so receipts and terminal tails remain readable.
  const text = message.text || '(empty report)';
  let ts = '';
  for (let i = 0; i < text.length; i += 3500) {
    const result = await slack.chat.postMessage({ channel, thread_ts: threadTs, text: text.slice(i, i + 3500),
      ...(i === 0 && message.blocks ? { blocks: message.blocks } : {}), unfurl_links: false, unfurl_media: false, parse: 'none' });
    ts ||= result.ts ?? '';
  }
  return ts;
}
export async function react(slack: Slack, channel: string, ts: string, name: string): Promise<void> {
  try { await slack.reactions.add({ channel, timestamp: ts, name }); }
  catch (error) { if ((error as { data?: { error?: string } }).data?.error !== 'already_reacted') throw error; }
}
