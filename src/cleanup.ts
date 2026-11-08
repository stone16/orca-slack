import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { runCommand, type RunCommand } from './commands.js';
import { parseEnvelope } from './orca.js';
import { queryPullRequests } from './pr-poller.js';
import { Store, type Worktree, type ObservedPullRequest, type CleanupReceipt } from './store.js';

interface AgentInventory {
  truncated: boolean;
  worktrees: { worktreeId: string; worktreeInstanceId: string; hostId: string;
    agents: { liveness: string }[]; unverifiableTerminalCount: number }[];
}
interface SafeWorktree {
  worktree: Worktree; instanceId: string; identity: string; path: string; pullRequests: ObservedPullRequest[]; finalCommit: string;
}
export type CleanupCheck = { allowed: false; reasons: string[] } | ({ allowed: true; reasons: [] } & SafeWorktree);
export type CleanupResult = { status: 'refused'; reasons: string[] } |
  { status: 'deleted' | 'already-deleted'; receipt: CleanupReceipt };
export class Cleanup {
  private queues = new Map<string, Promise<CleanupResult>>();
  constructor(private store: Store, private run: RunCommand = runCommand,
    private checkpoint: (step: 'after-save' | 'after-delete') => void | Promise<void> = () => {}) {}
  private async orca<T>(args: string[]): Promise<T> {
    const envelope = parseEnvelope(await this.run('orca', [...args, '--json']));
    if (!envelope.ok) throw new Error('Orca command failed');
    return envelope.result as T;
  }
  private async inventory(): Promise<AgentInventory> {
    const inventory = await this.orca<AgentInventory>(['worktree', 'ps', '--limit', '10000']);
    if (inventory?.truncated !== false || !Array.isArray(inventory.worktrees)) throw new Error('Incomplete agent inventory');
    return inventory;
  }
  private async absent(receipt: CleanupReceipt): Promise<boolean> {
    const inventory = await this.inventory();
    if (inventory.worktrees.some(row => row.worktreeId === receipt.worktreeId)) return false;
    try { lstatSync(receipt.path); return false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  }
  async check(worktreeId: string): Promise<CleanupCheck> {
    const tree = this.store.trackedWorktrees().find(tree => tree.id === worktreeId);
    if (!tree) return { allowed: false, reasons: ['Unknown worktree'] };
    const tracked = this.store.trackedWorktrees(tree.threadId);
    const trackedIds = new Set(tracked.map(worktree => worktree.id));
    const known = this.store.pullRequests(tree.threadId).filter(pr => trackedIds.has(pr.worktreeId));
    const prs: ObservedPullRequest[] = [];
    try {
      for (const worktree of tracked) {
        prs.push(...(await queryPullRequests(worktree, this.run)).map(pr => ({ ...pr,
          id: known.find(saved => saved.url === pr.url && saved.worktreeId === pr.worktreeId)?.id ?? pr.id })));
      }
    } catch { return { allowed: false, reasons: ['GitHub state unknown'] }; }
    const pullRequests = prs.filter(pr => pr.worktreeId === tree.id).sort((a, b) => a.number - b.number);
    if (!pullRequests.some(pr => pr.state === 'MERGED')) return { allowed: false, reasons: ['No merged pull request'] };
    if (prs.some(pr => pr.state !== 'MERGED') || known.some(saved =>
        !prs.some(pr => pr.url === saved.url && pr.worktreeId === saved.worktreeId))) {
      return { allowed: false, reasons: ['Unmerged or unknown pull request'] };
    }
    if (this.store.leadSessions(tree.threadId).some(session => session.active)) {
      return { allowed: false, reasons: ['Running agent'] };
    }
    let instanceId: string;
    try {
      const inventory = await this.inventory();
      for (const worktree of this.store.trackedWorktrees(tree.threadId)) {
        const rows = inventory.worktrees.filter(row => row.worktreeId === worktree.id);
        const row = rows[0];
        if (rows.length !== 1 || row.hostId !== 'local' || !row.worktreeInstanceId || !Array.isArray(row.agents) ||
            row.unverifiableTerminalCount !== 0) throw new Error('Unknown agent state');
        if (row.agents.some(agent => agent.liveness !== 'exited')) {
          return { allowed: false, reasons: [row.agents.some(agent => agent.liveness === 'live')
            ? 'Running agent' : 'Agent state unknown'] };
        }
      }
      instanceId = inventory.worktrees.find(row => row.worktreeId === tree.id)!.worktreeInstanceId;
    } catch { return { allowed: false, reasons: ['Agent state unknown'] }; }
    let path: string, identity: string;
    try {
      const { worktree } = await this.orca<{ worktree: {
        id: string; instanceId: string; identity: { key: string }; hostId: string; path: string; isMainWorktree: boolean;
      } }>(['worktree', 'show', '--worktree', `id:${tree.id}`]);
      if (worktree.id !== tree.id || worktree.instanceId !== instanceId || worktree.hostId !== 'local' ||
          typeof worktree.path !== 'string' || !isAbsolute(worktree.path) ||
          typeof worktree.identity?.key !== 'string' || !worktree.identity.key) throw new Error('Worktree identity changed');
      if (worktree.isMainWorktree !== false) return { allowed: false, reasons: ['Cannot clean main worktree'] };
      path = worktree.path;
      identity = worktree.identity.key;
    } catch { return { allowed: false, reasons: ['Worktree identity unknown'] }; }
    try {
      const git = (args: string[]) => this.run('git', ['-C', path, ...args]);
      if ((await git(['rev-parse', '--show-toplevel'])).trim() !== path ||
          (await git(['symbolic-ref', '--quiet', 'HEAD'])).trim() !== `refs/heads/${tree.branch.replace(/^refs\/heads\//, '')}`) {
        return { allowed: false, reasons: ['Worktree path or branch differs from ledger'] };
      }
      const reasons: string[] = [];
      if (await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'])) {
        reasons.push('Uncommitted or untracked changes');
      }
      if ((await git(['stash', 'list', '--format=%gd'])).trim()) reasons.push('Stash present');
      const finalCommit = (await git(['rev-parse', '--verify', 'HEAD'])).trim();
      if (pullRequests.at(-1)!.headRefOid !== finalCommit) reasons.push('HEAD differs from merged pull request head commit');
      if (reasons.length) return { allowed: false, reasons };
      return { allowed: true, reasons: [], worktree: tree, instanceId, identity, path, pullRequests, finalCommit };
    } catch { return { allowed: false, reasons: ['Git safety check failed'] }; }
  }
  confirm(worktreeId: string, user: string): Promise<CleanupResult> {
    const result = (this.queues.get(worktreeId) ?? Promise.resolve()).catch(() => {}).then(() => this.remove(worktreeId, user));
    this.queues.set(worktreeId, result);
    return result.finally(() => { if (this.queues.get(worktreeId) === result) this.queues.delete(worktreeId); });
  }
  private async remove(worktreeId: string, user: string): Promise<CleanupResult> {
    const previous = this.store.cleanupReceipt(worktreeId);
    const tree = previous?.worktree ?? this.store.trackedWorktrees().find(tree => tree.id === worktreeId);
    if (!tree || this.store.thread(tree.threadId)?.owner !== user) {
      return { status: 'refused', reasons: ['Only the thread owner can confirm cleanup'] };
    }
    if (previous?.state === 'deleted') return { status: 'already-deleted', receipt: previous };
    if (previous) {
      try {
        if (await this.absent(previous)) {
          this.store.markCleanupDeleted(worktreeId, { reconciled: true, worktreeAbsent: true, pathAbsent: true });
          return { status: 'deleted', receipt: this.store.cleanupReceipt(worktreeId)! };
        }
      } catch { return { status: 'refused', reasons: ['Worktree absence unknown'] }; }
    }
    const check = await this.check(worktreeId);
    if (!check.allowed) return { status: 'refused', reasons: check.reasons };
    if (previous && (previous.instanceId !== check.instanceId || previous.finalCommit !== check.finalCommit ||
        previous.path !== check.path || JSON.stringify(previous.pullRequests) !== JSON.stringify(check.pullRequests))) {
      return { status: 'refused', reasons: ['Worktree changed since cleanup was confirmed'] };
    }
    const sessions = this.store.leadSessions(tree.threadId).filter(session => session.worktreeId === tree.id);
    const dispatches = new Set(sessions.map(session => session.dispatchId));
    const reports = [...new Set(sessions.map(session => session.runId))].flatMap(runId => this.store.reports(runId))
      .filter(report => {
        try { return dispatches.has(JSON.parse(report.payload ?? '{}').dispatchId); }
        catch { return false; }
      });
    const receipt = previous ?? this.store.saveCleanupReceipt({ id: randomUUID(), worktreeId, threadId: tree.threadId,
      worktree: tree, instanceId: check.instanceId, identity: check.identity, path: check.path,
      finalCommit: check.finalCommit, pullRequests: check.pullRequests, sessions, reports,
      confirmedBy: user, savedAt: new Date().toISOString() });
    await this.checkpoint('after-save');
    const latest = await this.check(worktreeId);
    if (!latest.allowed) return { status: 'refused', reasons: latest.reasons };
    if (latest.instanceId !== receipt.instanceId || latest.identity !== receipt.identity || latest.path !== receipt.path ||
        latest.finalCommit !== receipt.finalCommit || JSON.stringify(latest.pullRequests) !== JSON.stringify(receipt.pullRequests)) {
      return { status: 'refused', reasons: ['Worktree changed since cleanup was confirmed'] };
    }
    let removalReceipt: unknown;
    try {
      removalReceipt = await this.orca(['worktree', 'rm', '--worktree', `identity:${receipt.identity}`]);
    } catch { return { status: 'refused', reasons: ['Orca deletion not confirmed; retry cleanup'] }; }
    await this.checkpoint('after-delete');
    try {
      if (!await this.absent(receipt)) return { status: 'refused', reasons: ['Orca deletion not confirmed; retry cleanup'] };
    } catch { return { status: 'refused', reasons: ['Worktree absence unknown'] }; }
    this.store.markCleanupDeleted(worktreeId, removalReceipt);
    return { status: 'deleted', receipt: this.store.cleanupReceipt(worktreeId)! };
  }
}
