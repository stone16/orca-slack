import { runCommand, type RunCommand } from './commands.js';
import { Store, type ObservedPullRequest, type Worktree } from './store.js';

export interface PollResult { changes: ObservedPullRequest[]; failures: { worktreeId: string; reason: string }[] }
export class PrPoller {
  constructor(private store: Store, private run: RunCommand = runCommand) {}
  start(onChange: (change: ObservedPullRequest) => void | Promise<void>,
    onFailure: (failure: PollResult['failures'][number]) => void | Promise<void>): () => void {
    let busy = false;
    const reportFailure = async (failure: PollResult['failures'][number]) => {
      try { await onFailure(failure); } catch {}
    };
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.poll(undefined, onChange).then(async result => {
        for (const failure of result.failures) await reportFailure(failure);
      }).finally(() => { busy = false; });
    }, 60_000);
    return () => clearInterval(timer);
  }
  async poll(threadId?: string, onChange?: (change: ObservedPullRequest) => void | Promise<void>): Promise<PollResult> {
    const result: PollResult = { changes: [], failures: [] };
    for (const tree of this.store.trackedWorktrees(threadId)) {
      try {
        this.store.observePullRequests(await queryPullRequests(tree, this.run));
      } catch { result.failures.push({ worktreeId: tree.id, reason: 'GitHub poll failed' }); }
    }
    const blocked = new Set<string>();
    for (const change of this.store.pendingPullRequestChanges(threadId)) {
      if (blocked.has(change.pullRequest.id)) continue;
      if (onChange) {
        try { await onChange(change.pullRequest); }
        catch {
          blocked.add(change.pullRequest.id);
          result.failures.push({ worktreeId: change.pullRequest.worktreeId, reason: 'PR change callback failed' });
          continue;
        }
      }
      result.changes.push(change.pullRequest);
      this.store.markPullRequestChangeDelivered(change.id);
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
