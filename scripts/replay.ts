import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { compareRun, type RunReport } from './report.ts';
import { modelPreflight } from './model-preflight.ts';

const runsIndex = process.argv.indexOf('--runs');
const runs = runsIndex === -1 ? 3 : Number(process.argv[runsIndex + 1]);
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('--runs must be between 1 and 10');
for (const key of ['LLM_API_KEY', 'LLM_MODEL', 'LLM_BASE_URL']) if (!process.env[key]) throw new Error(`Missing ${key}; configure .env first`);
const root = new URL('../', import.meta.url);
const expected = JSON.parse(await readFile(new URL('../tests/fixtures/week-a-expected.json', import.meta.url), 'utf8')) as Record<string, string>;
const reports: RunReport[] = [];
const sessionDirectory = join('out/verification', new Date().toISOString().replace(/[:.]/g, '-'));
console.log(`Replay artifacts: ${sessionDirectory}`);
async function freePort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function waitForApp(app: ChildProcess, port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (app.exitCode !== null || app.signalCode !== null) throw new Error('App stopped before startup');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch { /* app is still starting */ }
    await delay(100);
  }
  throw new Error('App did not become ready');
}
async function jsonLines(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
await mkdir('out/verification', { recursive: true });
for (let run = 1; run <= runs; run++) {
  const directory = join(sessionDirectory, `run-${run}`); await mkdir(directory, { recursive: true });
  let app: ChildProcess | undefined;
  let appExited = Promise.resolve();
  const report = compareRun(run, [], [], expected);
  reports.push(report);
  try {
    if (run === 1) await modelPreflight(join(directory, 'preflight-model-attempts.jsonl'));
    const port = await freePort();
    const pharmacyPort = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: root, env: { ...process.env, PORT: String(port), AUDIT_DIR: directory }, stdio: 'inherit' });
    app = child;
    appExited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
    await waitForApp(child, port);
    const sim = spawn(process.execPath, ['sim/sim.mjs', '--target', `http://127.0.0.1:${port}/webhooks`, '--pharmacy-port', String(pharmacyPort), '--log', join(directory, 'run-log.jsonl'), '--deliveries', join(directory, 'deliveries.jsonl')], { cwd: root, stdio: 'inherit' });
    const [exit] = await once(sim, 'exit');
    const orders = await jsonLines(join(directory, 'run-log.jsonl'));
    const deliveries = await jsonLines(join(directory, 'deliveries.jsonl'));
    Object.assign(report, compareRun(run, orders, deliveries, expected));
    assert.equal(exit, 0, `Run ${run}: simulator delivery failed`);
    assert.ok(report.passed, `Run ${run}: ${report.matched}/${Object.keys(expected).length} decisions match; see ${directory}/report.json`);
    console.log(`Verified run ${run}: ${orders.length}/${orders.length} decisions match`);
  } catch (error) {
    report.passed = false;
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (app && app.exitCode === null && app.signalCode === null) app.kill('SIGTERM');
    await appExited;
    await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    const summary = { model: process.env.LLM_MODEL, sessionDirectory, passed: reports.length === runs && reports.every(item => item.passed), reports };
    const json = `${JSON.stringify(summary, null, 2)}\n`;
    await writeFile(join(sessionDirectory, 'summary.json'), json);
    await writeFile('out/verification/summary.json', json);
  }
}
