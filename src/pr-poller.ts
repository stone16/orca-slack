import { runCommand, type RunCommand } from './commands.js';
import { Store, type ObservedPullRequest } from './store.js';

export interface PollResult { changes: ObservedPullRequest[]; failures: { worktreeId: string; reason: string }[] }
export class PrPoller {
  constructor(private store: Store, private run: RunCommand = runCommand) {}
  start(onChange: (change: ObservedPullRequest) => void, onFailure: (failure: PollResult['failures'][number]) => void): () => void {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.poll().then(result => {
        result.changes.forEach(onChange);
        result.failures.forEach(onFailure);
      }).finally(() => { busy = false; });
    }, 60_000);
    return () => clearInterval(timer);
  }
  async poll(threadId?: string): Promise<PollResult> {
    const result: PollResult = { changes: [], failures: [] };
    for (const tree of this.store.trackedWorktrees(threadId)) {
      try {
        const output = await this.run('gh', ['pr', 'list', '--repo', tree.repository, '--head', tree.branch,
          '--state', 'all', '--limit', '1000', '--json', 'number,url,state,headRefOid']);
        const prs = JSON.parse(output) as Omit<ObservedPullRequest, 'id' | 'worktreeId'>[];
        if (!Array.isArray(prs) || prs.length >= 1000 || prs.some(pr => !pr ||
            !Number.isSafeInteger(pr.number) || pr.number <= 0 ||
            typeof pr.url !== 'string' || !/^https:\/\/[^\s/]+\/.+\/pull\/\d+$/.test(pr.url) ||
            !['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) ||
            typeof pr.headRefOid !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(pr.headRefOid))) {
          throw new Error('Invalid or incomplete pull request list');
        }
        result.changes.push(...this.store.observePullRequests(prs.map(pr => ({ ...pr, id: pr.url, worktreeId: tree.id }))));
      } catch { result.failures.push({ worktreeId: tree.id, reason: 'GitHub poll failed' }); }
    }
    return result;
  }
}
