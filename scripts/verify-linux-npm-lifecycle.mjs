#!/usr/bin/env node
// Exercise a locally installed npm artifact, including its real wrappers and subprocesses.
// Usage on Linux: bun scripts/verify-linux-npm-lifecycle.mjs /path/to/node_modules/@openscout/scout
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

assert.equal(process.platform, 'linux', 'Run this artifact check on Linux');
const packageDir = resolve(process.argv[2] ?? 'packages/cli');
const root = mkdtempSync(join(tmpdir(), 'scout-linux-lifecycle-'));
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const projects = join(root, 'projects');
mkdirSync(projects);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENSCOUT_") && !key.startsWith("SCOUT_"))),
  HOME: root,
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_STATE_HOME: join(root, 'state'),
  OPENSCOUT_HOME: join(root, '.openscout'),
  OPENSCOUT_SUPPORT_DIRECTORY: join(root, 'support'),
  OPENSCOUT_CONTROL_HOME: join(root, 'control'),
  OPENSCOUT_BROKER_PORT: String(port),
  OPENSCOUT_BROKER_URL: `http://127.0.0.1:${port}`,
  OPENSCOUT_BROKER_SOCKET_PATH: join(root, 'broker.sock'),
  OPENSCOUT_NODE_ID: `linux-lifecycle-${process.pid}`,
  OPENSCOUT_MESH_ID: `linux-lifecycle-${process.pid}`,
  OPENSCOUT_MESH_SEEDS: '',
  OPENSCOUT_ADVERTISE_SCOPE: 'local',
  OPENSCOUT_SETUP_CWD: projects,
  OPENSCOUT_RUNTIME_BIN: join(packageDir, 'bin/openscout-runtime.mjs'),
  PATH: `${join(packageDir, 'bin')}:${process.env.PATH}`,
};
// Call the package wrappers directly; no operational wrapper or adapter override.
function cli(...args) {
  const result = spawnSync(join(packageDir, 'bin/scout'), args, { cwd: projects, env, encoding: 'utf8', timeout: 60_000 });
  assert.ifError(result.error);
  assert.ok(!`${result.stdout}\n${result.stderr}`.includes('ENOEXEC'), result.stderr);
  return result;
}
function doctor() {
  const result = cli('doctor', '--json');
  assert.equal(result.status, 0, result.stderr);
  let complete;
  try {
    const report = JSON.parse(result.stdout);
    complete = { report };
  } catch {
    complete = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.phase === 'complete');
  }
  assert.ok(complete, result.stdout);
  assert.equal(complete.report.nativeDaemon.notApplicableDetail, 'native supervisor: not applicable on linux');
  assert.equal(complete.report.nativeDaemon.error, null);
  assert.equal(complete.report.broker.serviceAdapter, 'headless-foreground');
  return complete.report;
}
let broker;
let output = '';
try {
  const first = cli('setup', '--source-root', projects, '--json');
  assert.equal(first.status, 1, first.stderr);
  const configured = JSON.parse(first.stdout);
  assert.equal(configured.broker.health.ok, false);
  assert.match(configured.brokerWarning, /openscout-runtime broker/);
  assert.equal(doctor().broker.health.ok, false);
  broker = spawn(join(packageDir, 'bin/openscout-runtime.mjs'), ['broker'], { cwd: projects, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  broker.on('error', error => { output += String(error); });
  broker.stdout.on('data', chunk => { output += chunk; });
  broker.stderr.on('data', chunk => { output += chunk; });
  let healthy = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const health = await (await fetch(`${env.OPENSCOUT_BROKER_URL}/health`, { signal: AbortSignal.timeout(500) })).json();
      if (health.ok) { healthy = true; break; }
    } catch {}
    if (broker.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(healthy, `Broker did not become healthy:\n${output}`);
  const second = cli('setup', '--source-root', projects, '--json');
  assert.equal(second.status, 0, second.stderr);
  const ready = JSON.parse(second.stdout);
  assert.equal(ready.broker.health.ok, true);
  assert.equal(ready.brokerWarning, null);
  assert.equal(doctor().broker.health.ok, true);
  console.log(JSON.stringify({ ok: true, platform: process.platform, packageDir, checks: ['setup reports unready', 'doctor before start', 'default foreground broker boots', 'setup recognizes external supervision', 'doctor after start'], port }));
} finally {
  if (broker?.pid) {
    try { process.kill(-broker.pid, 'SIGTERM'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
    try { process.kill(-broker.pid, 'SIGKILL'); } catch {}
  }
  rmSync(root, { recursive: true, force: true });
}
