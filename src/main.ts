import { resolve } from 'node:path';
import { loadConfig, redactingLog } from './config.js';
import { serve } from './service.js';

const log = redactingLog(process.env);
try {
  const config = loadConfig(resolve(process.env.BRIDGE_CONFIG ?? 'config.local.json'));
  await serve(config, { log });
} catch (error) {
  log('error', error);
  process.exitCode = 1;
}
