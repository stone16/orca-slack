import type { RoutingSample } from './store.js';

export interface Repository { id: string; name: string; aliases: readonly string[] }

export function classify(threadId: string, text: string, repositories: readonly Repository[]): RoutingSample {
  const matches = repositories.filter(repo => [repo.name, ...repo.aliases].some(alias => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
  }));
  const spec = text.replace(/<@[^>]+>/g, '').trim();
  const asksHow = /^(where|why|how|what|which|when|does|is|are|can you explain)\b|^(为什么|如何|怎么|哪里|在哪)/i.test(spec);
  const implement = /\b(fix|implement|change|replace|remove|add)\b|修复|修一下|改成|修改|实现|添加/i.test(spec);
  const question = asksHow || (!implement && /\b(where|why|how|what|which|when)\b|[?？]|在哪|哪里|为什么|如何|怎么配置/i.test(spec));
  return { threadId, text, repository: matches.length === 1 ? matches[0].id : null,
    intent: question ? 'question' : implement ? 'implement' : 'clarify',
    rule: matches.length === 1 ? 'alias' : matches.length > 1 ? 'ambiguous-repository' : 'unknown-repository' };
}
