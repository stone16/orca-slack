import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type RunCommand = (program: 'gh' | 'git' | 'orca', args: string[], terminal?: string) => Promise<string>;
const execute = promisify(execFile);
export const runCommand: RunCommand = async (program, args) => {
  const { stdout } = await execute(program, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};
