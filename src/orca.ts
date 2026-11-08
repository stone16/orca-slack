import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface Orca { call<T = Record<string, unknown>>(verb: string, args?: string[]): Promise<T> }
export interface Message {
  id: string; type: string; sequence?: number; subject?: string; body?: string | null; payload?: string | null;
}
export interface Inbox { count: number; messages: (Message & { sequence: number })[] }
export interface StartReceipt {
  dispatchId?: string; taskId?: string; runId?: string;
  stage?: string; failedStage?: string; lastError?: string;
  effects?: { kind?: string; id?: string }[];
}
export class OrcaError extends Error {
  constructor(message: string, readonly receipt: StartReceipt = {}) { super(message); }
}
export function parseEnvelope(output: string): { ok: boolean; result?: unknown; error?: { message?: string } } {
  let start = -1, depth = 0, quoted = false, escaped = false;
  let last: ReturnType<typeof parseEnvelope> | undefined;
  for (let i = 0; i < output.length; i++) {
    const c = output[i];
    if (start < 0) { if (c !== '{') continue; start = i; }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      const parsed = JSON.parse(output.slice(start, i + 1));
      if (!parsed._keepalive && !parsed._heartbeat) last = parsed;
      start = -1;
    }
  }
  if (!last || typeof last.ok !== 'boolean') throw new Error('Orca returned no complete JSON envelope');
  return last;
}
const execute = promisify(execFile);
export type Command = (args: string[]) => Promise<{ stdout: string; failed?: boolean }>;
const command: Command = async args => {
  try {
    return await execute('orca', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { stdout: e.stdout || e.stderr || '', failed: true };
  }
};
export class CliOrca implements Orca {
  constructor(private execute: Command = command) {}
  async call<T = Record<string, unknown>>(verb: string, args: string[] = []): Promise<T> {
    const { stdout: output, failed } = await this.execute(['orchestration', verb, ...args, '--json', '--full']);
    let envelope: ReturnType<typeof parseEnvelope>;
    try { envelope = parseEnvelope(output); }
    catch { throw new OrcaError(`Orca ${verb} failed without a JSON receipt`); }
    if (failed || !envelope.ok) {
      const receipt = (envelope.result ?? {}) as StartReceipt;
      throw new OrcaError(`${receipt.failedStage ?? receipt.stage ?? verb}: ${receipt.lastError ?? envelope.error?.message ?? 'command failed'}`, receipt);
    }
    return envelope.result as T;
  }
  async peek(runId: string): Promise<Message[]> {
    return this.messages(await this.call('check', ['--run', runId, '--peek']));
  }
  async consume(runId: string): Promise<Message[]> {
    return this.messages(await this.call('check', ['--run', runId]));
  }
  async inbox(runId: string): Promise<Inbox> {
    const result = await this.call('inbox', ['--terminal', `run:${runId}`, '--limit', '1000']);
    const messages = this.messages(result);
    if (!Number.isInteger(result.count) || result.count !== messages.length || messages.length > 1000 ||
        messages.some(message => !Number.isSafeInteger(message.sequence) || message.sequence! < 0)) {
      throw new OrcaError('Invalid inbox history or sequence');
    }
    return { count: result.count as number, messages: messages as Inbox['messages'] };
  }
  private messages(value: Record<string, unknown>): Message[] {
    if (!value || !Array.isArray(value.messages) || value.messages.some(message =>
      !message || typeof message.id !== 'string' || !message.id || typeof message.type !== 'string' ||
      (message.sequence !== undefined && (!Number.isSafeInteger(message.sequence) || message.sequence < 0)) ||
      (message.body != null && typeof message.body !== 'string') ||
      (message.payload != null && typeof message.payload !== 'string'))) {
      throw new OrcaError('Invalid Orca message batch');
    }
    return value.messages as Message[];
  }
}
