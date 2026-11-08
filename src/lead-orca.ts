import { CliOrca, command, OrcaError, parseEnvelope, type Command, type Orca } from './orca.js';

export interface CreatedWorktree { id: string; branch: string }
export interface TerminalRead { status: string; source?: string; nextCursor?: string }
export interface LeadOrca extends Orca {
  createWorktree(repository: string, name: string): Promise<CreatedWorktree>;
  readTerminal(handle: string, cursor?: string): Promise<TerminalRead>;
}

export class LeadCli extends CliOrca implements LeadOrca {
  constructor(private run: Command = command) { super(run); }
  private async outside<T>(args: string[]): Promise<T> {
    const output = await this.run([...args, '--json']);
    const envelope = parseEnvelope(output.stdout);
    if (output.failed || !envelope.ok) throw new OrcaError(envelope.error?.message ?? 'Orca command failed');
    return envelope.result as T;
  }
  async createWorktree(repository: string, name: string): Promise<CreatedWorktree> {
    const result = await this.outside<{ worktree: CreatedWorktree }>(['worktree', 'create', '--repo', `id:${repository}`,
      '--name', name, '--no-parent', '--setup', 'skip']);
    const tree = result?.worktree;
    if (!tree || typeof tree.id !== 'string' || !tree.id || typeof tree.branch !== 'string' || !tree.branch) {
      throw new OrcaError('Invalid worktree receipt');
    }
    return { id: tree.id, branch: tree.branch.replace(/^refs\/heads\//, '') };
  }
  async readTerminal(handle: string, cursor?: string): Promise<TerminalRead> {
    const result = await this.outside<TerminalRead | { terminal: TerminalRead }>(['terminal', 'read', '--terminal', handle,
      ...(cursor === undefined ? [] : ['--cursor', cursor])]);
    const terminal = result && 'terminal' in result ? result.terminal : result;
    if (!terminal || typeof terminal.status !== 'string') throw new OrcaError('Invalid terminal read');
    return terminal;
  }
}
