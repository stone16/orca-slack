import type { ChannelConfig } from './config.js';

export function stripMention(text: string, botId: string): string {
  return text.split(`<@${botId}>`).join('').trim();
}
export function route(config: ChannelConfig, text: string, botId = text.match(/^\s*<@([^>]+)>/)?.[1] ?? ''): string[] {
  const spec = stripMention(text, botId);
  if (!spec) throw new Error('Empty task');
  return ['--spec', spec, '--worktree', 'new-child', '--repo', config.repo,
    '--agent', config.agent, '--model', config.model, '--effort', config.effort];
}
