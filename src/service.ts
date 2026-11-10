import { redactingLog, type Config } from './config.js';
import { Runtime, type RuntimeOptions } from './runtime.js';

export async function serve(config: Config, options: RuntimeOptions = {}): Promise<Runtime> {
  const log = options.log ?? redactingLog(process.env);
  const runtime = new Runtime(config, { ...options, log });
  let stopping = false;
  const finish = (code: number) => {
    clearTimeout(deadline);
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    log('info', `bridge stopped code=${code}`);
    process.exit(code);
  };
  let deadline: ReturnType<typeof setTimeout>;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    log('info', 'bridge stopping');
    deadline = setTimeout(() => { log('error', 'shutdown deadline exceeded; ledger will replay on restart'); finish(1); }, config.shutdownTimeoutMs);
    void runtime.stop().then(() => finish(code), error => { log('error', error); finish(1); });
  };
  const interrupt = () => stop(0), terminate = () => stop(0);
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try { await runtime.start(); }
  catch (error) { log('error', error); stop(1); }
  return runtime;
}
