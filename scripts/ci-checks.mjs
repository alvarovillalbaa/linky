import { spawn, execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import assert from 'node:assert/strict';

if (process.env.CI !== 'true' || process.env.LINKY_DISPOSABLE_DATABASE !== 'true') throw new Error('Disposable CI scope required.');
const hash = value => createHash('sha256').update(value).digest('hex');
async function seal() {
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' });
  assert.equal(status, '', 'Acceptance requires clean tracked and untracked source.');
  const index = execFileSync('git', ['ls-files', '--stage', '-z'], { encoding: 'utf8' });
  const files = await Promise.all(index.split('\0').filter(Boolean).map(async entry => {
    const [metadata, path] = entry.split('\t');
    assert.match(metadata, /^100644 [0-9a-f]{40} 0$/u);
    const stat = await lstat(path); assert(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.mode & 0o111, 0);
    const data = await readFile(path);
    const blob = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
    assert.equal(blob, metadata.split(' ')[1]);
    return { path, bytes: data.length, mode: stat.mode & 0o777, sha256: hash(data), git: metadata };
  }));
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  assert.equal(execFileSync('git', ['write-tree'], { encoding: 'utf8' }).trim(), tree);
  return { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), tree, status, indexSha256: hash(index), files };
}
const before = await seal();
const receipt = { schemaVersion: 1, node: process.version, startedAt: new Date().toISOString(), before, commands: [] };
let interrupted = null, activeChild = null;
const signalHandlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => {
  interrupted ??= signal;
  if (activeChild?.pid) { try { process.kill(-activeChild.pid, 'SIGTERM'); } catch {} }
}]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);
async function run(name, args, capMs) {
  if (interrupted) throw new Error('Execution interrupted before stage.');
  const started = Date.now(); let size = 0; let timedOut = false, closeObserved = false; const chunks = [];
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  activeChild = child;
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, capMs);
  const kill = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, capMs + 3000);
  for (const [stream, label] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', data => {
    size += data.length;
    if (size > 2_000_000) { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} return; }
    chunks.push({ stream: label, data: Buffer.from(data) });
  });
  let drainTimer, interruptKill;
  const signalStops = [...signalHandlers.keys()].map(signal => {
    const stop = () => { interruptKill ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000); };
    process.on(signal, stop); return [signal, stop];
  });
  const result = await new Promise(resolve => {
    child.once('error', () => resolve({ code: null, signal: 'spawn_error' }));
    child.once('close', (code, signal) => { closeObserved = true; resolve({ code, signal }); });
    // Failure to drain is retained as uncertain, never called clean EOF.
    drainTimer = setTimeout(() => {
      child.stdout.destroy(); child.stderr.destroy();
      resolve({ code: child.exitCode, signal: 'drain_deadline' });
    }, capMs + 8000);
  });
  clearTimeout(timer); clearTimeout(kill); clearTimeout(drainTimer); clearTimeout(interruptKill);
  for (const [signal, stop] of signalStops) process.removeListener(signal, stop);
  activeChild = null;
  let groupGone = false;
  try { process.kill(-child.pid, 0); } catch (error) { groupGone = error.code === 'ESRCH'; }
  const streams = ['stdout', 'stderr'].map(stream => {
    const raw = Buffer.concat(chunks.filter(x => x.stream === stream).map(x => x.data));
    return { stream, bytes: raw.length, sha256: hash(raw), zlibBase64: deflateSync(raw).toString('base64') };
  });
  receipt.commands.push({ name, args, startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started, ...result, timedOut, groupGone, closeObserved, interrupted, streams });
  if (result.code !== 0 || timedOut || !groupGone || !closeObserved || interrupted) throw new Error(`Stage failed: ${name}`);
}
try {
  await run('source checks', ['scripts/check.mjs'], 60000);
  if (process.env.LINKY_REUSE_BACKEND_RECEIPT === 'service-attempt-1') {
    const path = 'docs/results/2026/11-05/service-attempt-1.json';
    const raw = await readFile(path); const previous = JSON.parse(raw);
    assert.equal(hash(raw), '91952a4560a6acc13e653280d95072eaa9faaff324e399807adf2cc3cb48a102');
    assert.equal(previous.before.head, 'b9405c02c8bf4defdd46c28a75b10af98d6b9d11');
    assert.equal(previous.node, process.version); assert.equal(previous.sourceUnchanged, true);
    assert.deepEqual(previous.after, previous.before);
    const current = new Map(before.files.map(file => [file.path, file]));
    const stable = previous.before.files.filter(file => !file.path.startsWith('docs/') && !file.path.startsWith('.github/')
      && !['AGENTS.md', 'README.md', 'scripts/ci-checks.mjs', 'tests/browser/service.mjs'].includes(file.path));
    for (const file of stable) assert.deepEqual(current.get(file.path), file);
    const carried = [];
    for (const [name, count] of [['unit and HTTP boundary checks', 50], ['real PostgreSQL checks', 18]]) {
      const command = previous.commands.find(row => row.name === name);
      assert(command && command.code === 0 && command.closeObserved && command.groupGone && !command.timedOut && !command.interrupted);
      for (const stream of command.streams) {
        const bytes = inflateSync(Buffer.from(stream.zlibBase64, 'base64'));
        assert.equal(bytes.length, stream.bytes); assert.equal(hash(bytes), stream.sha256);
        if (stream.stream === 'stdout') {
          const output = bytes.toString('utf8');
          for (const [key, number] of [['tests', count], ['pass', count], ['fail', 0], ['cancelled', 0], ['skipped', 0], ['todo', 0]]) assert(new RegExp(`^# ${key} ${number}$`, 'm').test(output));
        }
      }
      carried.push({ name, passedCases: count, repeatedCases: 0 });
    }
    receipt.carriedForward = { path, sha256: hash(raw), stableInputCount: stable.length, sourceCommit: previous.before.head, commands: carried };
    await run('prepare fresh disposable schema', ['scripts/setup-disposable.mjs'], 60000);
  } else {
    const unit = (await readdir('tests/unit')).filter(x => x.endsWith('.test.mjs')).sort().map(x => `tests/unit/${x}`);
    await run('unit and HTTP boundary checks', ['--test', '--test-reporter=tap', ...unit], 120000);
    await run('real PostgreSQL checks', ['--test', '--test-reporter=tap', 'tests/integration/database.test.mjs'], 180000);
  }
  await run('desktop and narrow browser journeys', ['tests/browser/service.mjs'], 180000);
  receipt.passed = true;
} catch (error) { receipt.passed = false; receipt.failure = error.message; }
try { receipt.after = await seal(); assert.deepEqual(receipt.after, before); receipt.sourceUnchanged = true; }
catch { receipt.sourceUnchanged = false; receipt.passed = false; }
receipt.finishedAt = new Date().toISOString();
receipt.interrupted = interrupted;
if (interrupted) receipt.passed = false;
for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
await writeFile(process.env.RUNNER_TEMP + '/linky-check-receipt.json', JSON.stringify(receipt));
console.log('LINKY_CHECK_RECEIPT=' + deflateSync(Buffer.from(JSON.stringify(receipt))).toString('base64'));
console.log(JSON.stringify({ passed: receipt.passed, sourceUnchanged: receipt.sourceUnchanged, commands: receipt.commands.map(({ name, code, timedOut, groupGone }) => ({ name, code, timedOut, groupGone })) }));
process.exitCode = receipt.passed ? 0 : 1;
