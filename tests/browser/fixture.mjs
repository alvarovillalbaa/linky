import assert from 'node:assert/strict';
import { mkdtemp, chmod, lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { startServer } from '../../scripts/serve.mjs';
import { provisionWorkspace } from '../../scripts/provision-workspace.mjs';
import { createPostgresRepository } from '../../server/postgres.mjs';

export const eventually = async (read, cap = 10000) => {
  const end = Date.now() + cap;
  for (;;) { try { return await read(); } catch (error) { if (Date.now() >= end) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
};
export const redactFailure = error => ({ name: error.name,
  message: String(error.message).replace(/ly[ori]_[0-9a-f]{64}/giu, '[disposable capability redacted]'),
  stack: String(error.stack).replace(/ly[ori]_[0-9a-f]{64}/giu, '[disposable capability redacted]') });

export async function withExtensionFixture(work) {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.LINKY_DISPOSABLE_DATABASE, 'true');
  assert.equal(process.env.LINKY_DISPOSABLE_DB, 'linky-pg17-extension-v2');
  assert.equal(process.env.LINKY_TEST_DATABASE_URL, 'postgresql://postgres:authored-ci-only@127.0.0.1:5432/linky_extension_checks');
  const { Client } = await import('pg');
  const { chromium } = await import(pathToFileURL(process.env.LINKY_PLAYWRIGHT_MODULE).href);
  const admin = new Client({ connectionString: process.env.LINKY_TEST_DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  let scratch, identity, repository, app, browserServer, browser, browserPgid, interrupted = null, failure;
  const contexts = [];
  const lifecycle = { contextsCreated: 0, contextsClosed: 0, browserClosed: false, browserGroupGone: false, serverClosed: false, poolClosed: false, adminClosed: false, scratchRemoved: false };
  const signals = new Map(['SIGINT','SIGTERM','SIGHUP'].map(signal => [signal, () => { interrupted ??= signal; void browserServer?.close().catch(() => {}); }]));
  for (const [signal, handler] of signals) process.on(signal, handler);
  const results = [], cleanupFailures = [], finalChecks = [];
  try {
    scratch = await mkdtemp(join(tmpdir(), 'linky-extension-')); await chmod(scratch, 0o700); identity = await lstat(scratch);
    await admin.connect();
    const row = (await admin.query("SELECT current_database() AS name, current_setting('server_version_num')::int AS version, pg_catalog.shobj_description(oid, 'pg_database') AS marker FROM pg_catalog.pg_database WHERE datname = current_database()")).rows[0];
    assert.deepEqual({ name: row.name, major: Math.floor(row.version / 10000), marker: row.marker }, { name: 'linky_extension_checks', major: 17, marker: 'linky-extension-disposable-ci-v2' });
    await admin.query("ALTER ROLE linky_runtime PASSWORD 'authored-browser-runtime'; ALTER ROLE linky_operator PASSWORD 'authored-browser-operator'");
    const runtime = new URL(process.env.LINKY_TEST_DATABASE_URL); runtime.username = 'linky_runtime'; runtime.password = 'authored-browser-runtime';
    const operator = new URL(process.env.LINKY_TEST_DATABASE_URL); operator.username = 'linky_operator'; operator.password = 'authored-browser-operator';
    repository = await createPostgresRepository({ connectionString: runtime.href, allowInsecureLoopback: true });
    app = await startServer({ repository });
    browserServer = await chromium.launchServer({ headless: true });
    const pid = browserServer.process().pid, stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    browserPgid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]); assert.equal(browserPgid, pid);
    browser = await chromium.connect(browserServer.wsEndpoint());
    const createWorkspace = async name => {
      const input = { name, recoveryFile: join(scratch, name + '.json'), connectionString: operator.href, allowInsecureLoopback: true };
      const initial = await provisionWorkspace(input), replay = await provisionWorkspace(input);
      assert.equal(replay.workspaceId, initial.workspaceId); assert.equal(replay.replayed, true);
      return JSON.parse(await readFile(input.recoveryFile, 'utf8'));
    };
    const createContext = async viewport => {
      const context = await browser.newContext({ viewport }); contexts.push(context); lifecycle.contextsCreated++;
      context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(15000);
      context.on('page', page => page.on('dialog', dialog => dialog.accept()));
      return context;
    };
    await work({ admin, app, browser, results, createWorkspace, createContext, afterClose: check => finalChecks.push(check) });
  } catch (error) { failure = redactFailure(error); }
  finally {
    for (const context of contexts) { try { await context.close(); lifecycle.contextsClosed++; } catch {} }
    await new Promise(resolve => setImmediate(resolve));
    for (const verify of finalChecks) {
      try { await verify(); } catch (error) { const safe = redactFailure(error); cleanupFailures.push(safe); failure ??= safe; }
    }
    try { if (browser?.isConnected()) await browser.close(); await browserServer?.close(); lifecycle.browserClosed = Boolean(browserServer); } catch {}
    if (browserPgid) { try { await eventually(async () => { let gone = false; try { process.kill(-browserPgid, 0); } catch (error) { gone = error.code === 'ESRCH'; } assert(gone); }, 5000); lifecycle.browserGroupGone = true; } catch {} }
    try { await app?.close(); lifecycle.serverClosed = Boolean(app); } catch {}
    try { await repository?.close(); lifecycle.poolClosed = Boolean(repository); } catch {}
    try { await admin.end(); lifecycle.adminClosed = true; } catch {}
    try {
      if (scratch && !interrupted && lifecycle.browserClosed && lifecycle.browserGroupGone && lifecycle.serverClosed && lifecycle.poolClosed && lifecycle.adminClosed && lifecycle.contextsClosed === lifecycle.contextsCreated) {
        const current = await lstat(scratch);
        if (current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino && current.uid === identity.uid) { await rm(scratch, { recursive: true }); lifecycle.scratchRemoved = true; }
      }
    } catch (error) { const safe = redactFailure(error); cleanupFailures.push(safe); failure ??= safe; }
    for (const [signal, handler] of signals) process.removeListener(signal, handler);
  }
  const passed = !failure && !interrupted && results.length === 2 && results.every(x => x.passed) && lifecycle.contextsCreated === lifecycle.contextsClosed
    && ['browserClosed','browserGroupGone','serverClosed','poolClosed','adminClosed','scratchRemoved'].every(key => lifecycle[key]);
  console.log(JSON.stringify({ schemaVersion: 1, browserVersion: browser?.version(), results, lifecycle, interrupted, cleanupFailures, ...(failure ? { failure } : {}), passed }));
  if (!passed) process.exitCode = 1;
}
