import { runCommand, type RunCommand } from './commands.js';
import { Store, type ObservedPullRequest, type Worktree } from './store.js';

export interface PollResult { changes: ObservedPullRequest[]; failures: { worktreeId: string; reason: string }[] }
export class PrPoller {
  constructor(private store: Store, private run: RunCommand = runCommand) {}
  start(onChange: (change: ObservedPullRequest) => void, onFailure: (failure: PollResult['failures'][number]) => void): () => void {
    let busy = false;
    const reportFailure = (failure: PollResult['failures'][number]) => {
      try { onFailure(failure); } catch {}
    };
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.poll().then(result => {
        for (const change of result.changes) {
          try { onChange(change); }
          catch { reportFailure({ worktreeId: change.worktreeId, reason: 'PR change callback failed' }); }
        }
        result.failures.forEach(reportFailure);
      }).finally(() => { busy = false; });
    }, 60_000);
    return () => clearInterval(timer);
  }
  async poll(threadId?: string): Promise<PollResult> {
    const result: PollResult = { changes: [], failures: [] };
    for (const tree of this.store.trackedWorktrees(threadId)) {
      try {
        result.changes.push(...this.store.observePullRequests(await queryPullRequests(tree, this.run)));
      } catch { result.failures.push({ worktreeId: tree.id, reason: 'GitHub poll failed' }); }
    }
    return result;
  }
}

export async function queryPullRequests(tree: Worktree, run: RunCommand): Promise<ObservedPullRequest[]> {
  const output = await run('gh', ['pr', 'list', '--repo', tree.repository, '--head', tree.branch.replace(/^refs\/heads\//, ''),
    '--state', 'all', '--limit', '1000', '--json', 'number,url,state,headRefOid']);
  const prs = JSON.parse(output) as Omit<ObservedPullRequest, 'id' | 'worktreeId'>[];
  if (!Array.isArray(prs) || prs.length >= 1000 || prs.some(pr => !pr ||
      !Number.isSafeInteger(pr.number) || pr.number <= 0 ||
      typeof pr.url !== 'string' || !/^https:\/\/[^\s/]+\/.+\/pull\/\d+$/.test(pr.url) ||
      !['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) ||
      typeof pr.headRefOid !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(pr.headRefOid))) {
    throw new Error('Invalid or incomplete pull request list');
  }
  return prs.map(pr => ({ id: pr.url, worktreeId: tree.id, url: pr.url,
    number: pr.number, state: pr.state, headRefOid: pr.headRefOid }));
}
