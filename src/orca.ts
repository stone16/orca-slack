import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface Orca { call<T = Record<string, unknown>>(verb: string, args?: string[]): Promise<T> }
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
export class CliOrca implements Orca {
  async call<T = Record<string, unknown>>(verb: string, args: string[] = []): Promise<T> {
    let output: string;
    let failed = false;
    try {
      ({ stdout: output } = await execute('orca', ['orchestration', verb, ...args, '--json'],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 660_000 }));
    } catch (error) {
      failed = true;
      const e = error as { stdout?: string; stderr?: string };
      output = e.stdout || e.stderr || '';
    }
    let envelope: ReturnType<typeof parseEnvelope>;
    try { envelope = parseEnvelope(output); }
    catch { throw new OrcaError(`Orca ${verb} failed without a JSON receipt`); }
    if (failed || !envelope.ok) {
      const receipt = (envelope.result ?? {}) as StartReceipt;
      throw new OrcaError(`${receipt.failedStage ?? receipt.stage ?? verb}: ${receipt.lastError ?? envelope.error?.message ?? 'command failed'}`, receipt);
    }
    return envelope.result as T;
  }
}
