import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Store } from '../src/store.js';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'bridge-signal-'));
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--outDir', join(root, 'build')], { stdio: 'pipe' });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
});
afterAll(() => { if (root) rmSync(root, { recursive: true }); });
async function waitFor(check: () => boolean, milliseconds = 8_000) {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Child service did not reach its checkpoint');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`${signal} drains a scripted report, disconnects Socket Mode, exits zero, and reopens the ledger`, async () => {
    const checkout = mkdtempSync(join(root, 'checkout-'));
    const script = join(checkout, 'child.mjs');
    writeFileSync(script, `
      import { EventEmitter } from 'node:events';
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { parseConfig } from '../build/config.js';
      import { serve } from '../build/service.js';
      import { SlackAdapter } from '../build/bolt.js';
      const checkout = process.cwd();
      const config = parseConfig({botId:'U00000001',ownerId:'U00000002',allowedUsers:['U00000002'],runId:'run_fixture',coordinatorTerminal:'term_fixture',agent:'codex',archiveDirectory:'../archive',hooksDirectory:'../hooks',shutdownTimeoutMs:3000,repositories:[{id:'repo',name:'example',aliases:[],path:'../repo',github:'example/project'}]},process.env,checkout);
      let received = false;
      const message = {id:'report',type:'status',sequence:1,body:'durable after signal'};
      await serve(config, {
        installGuard: () => '',
        checkpoint: async step => {
          if (step === 'after-consume') {
            writeFileSync(join(checkout,'paused'),'');
            await new Promise(resolve => setTimeout(resolve,250));
          }
        },
        run: async (program,args) => {
          let result = {};
          if (args[1] === 'inbox') result = { count: received ? 1 : 0, messages: received ? [message] : [] };
          if (args[1] === 'check') {
            result = {messages:[message]};
            if (!args.includes('--peek')) received = true;
          }
          return JSON.stringify({ok:true,result});
        },
        socketMode: (store,options) => ({
          adapter: new SlackAdapter({},store,options),socket:new EventEmitter(),
          app: { start:async()=>{}, stop:async()=>{writeFileSync(join(checkout,'disconnected'),'');} }
        })
      });
    `);
    const child = spawn(process.execPath, [script], { cwd: checkout, env: { ...process.env,
      SLACK_BOT_TOKEN: 'xoxb-signal-secret', SLACK_APP_TOKEN: 'xapp-signal-secret' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    try {
      await waitFor(() => existsSync(join(checkout, 'paused')));
      child.kill(signal);
      expect(await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 4_000))])).toEqual({ code: 0, signal: null });
      expect(existsSync(join(checkout, 'disconnected'))).toBe(true);
      const reopened = new Store(join(checkout, 'data', 'bridge.sqlite'));
      try { expect(reopened.reports('run_fixture')).toEqual([expect.objectContaining({ id: 'report', state: 'sent', sequence: 1 })]); }
      finally { reopened.close(); }
      expect(output).toContain('bridge stopped');
      expect(output).not.toContain('xoxb-signal-secret'); expect(output).not.toContain('xapp-signal-secret');
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  }, 12_000);
}
test('entry point rejects malformed startup configuration without logging tokens', async () => {
  const checkout = mkdtempSync(join(root, 'bad-config-'));
  writeFileSync(join(checkout, 'config.local.json'), JSON.stringify({ botId: 'xoxb-startup-secret' }));
  const child = spawn(process.execPath, [join(root, 'build', 'main.js')], { cwd: checkout, env: { ...process.env,
    SLACK_BOT_TOKEN: 'xoxb-startup-secret', SLACK_APP_TOKEN: 'xapp-startup-secret' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  expect(code).toBe(1);
  expect(output).toContain('configuration field');
  expect(output).not.toContain('xoxb-startup-secret'); expect(output).not.toContain('xapp-startup-secret');
});


for (const fatal of ['unhandled rejection', 'uncaught exception']) {
  test(`${fatal} redacts credentials and disconnects through failed shutdown`, async () => {
    const checkout = mkdtempSync(join(root, 'fatal-'));
    const script = join(checkout, 'child.mjs');
    const trigger = fatal === 'unhandled rejection' ? 'void Promise.reject(new Error(process.env.SLACK_APP_TOKEN));' : 'setImmediate(() => { throw new Error(process.env.SLACK_BOT_TOKEN); });';
    writeFileSync(script, `
      import { EventEmitter } from 'node:events';
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { parseConfig } from '../build/config.js';
      import { serve } from '../build/service.js';
      import { SlackAdapter } from '../build/bolt.js';
      const config = parseConfig({botId:'U00000001',ownerId:'U00000002',allowedUsers:['U00000002'],runId:'run_fixture',coordinatorTerminal:'term_fixture',agent:'codex',archiveDirectory:'../archive',hooksDirectory:'../hooks',shutdownTimeoutMs:3000,repositories:[{id:'repo',name:'example',aliases:[],path:'../repo',github:'example/project'}]},process.env,process.cwd());
      await serve(config, {
        installGuard: () => '',
        run: async () => JSON.stringify({ok:true,result:{count:0,messages:[]}}),
        socketMode: (store,options) => ({adapter:new SlackAdapter({},store,options),socket:new EventEmitter(),app:{start:async()=>{},stop:async()=>{writeFileSync(join(process.cwd(),'disconnected'),'');}}})
      });
      ${trigger}
    `);
    const child = spawn(process.execPath, [script], { cwd: checkout, env: { ...process.env,
      SLACK_BOT_TOKEN: 'xoxb-fatal-secret', SLACK_APP_TOKEN: 'xapp-fatal-secret' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    try {
      const code = await new Promise(resolve => child.on('exit', resolve));
      expect(code).toBe(1);
      expect(existsSync(join(checkout, 'disconnected'))).toBe(true);
      expect(output).toContain('[redacted]'); expect(output).toContain('bridge stopped code=1');
      expect(output).not.toContain('xoxb-fatal-secret'); expect(output).not.toContain('xapp-fatal-secret');
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
}
