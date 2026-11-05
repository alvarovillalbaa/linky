import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, chmod, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../../scripts/serve.mjs';
import { provisionWorkspace } from '../../scripts/provision-workspace.mjs';
import { createPostgresRepository } from '../../server/postgres.mjs';

assert.equal(process.env.CI, 'true');
assert.equal(process.env.LINKY_DISPOSABLE_DATABASE, 'true');
const database = new URL(process.env.LINKY_TEST_DATABASE_URL);
assert.equal(process.env.LINKY_DISPOSABLE_DB, 'linky-pg17-ci-v1');
assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.pathname, '/linky_checks');
const { Client } = await import('pg');
const { chromium } = await import(pathToFileURL(process.env.LINKY_PLAYWRIGHT_MODULE).href);
const admin = new Client({ connectionString: database.href });
const results = []; let browserServer, browser, app, repository, scratch, scratchIdentity, browserPgid;
const lifecycle = { contextsClosed: 0, expectedContexts: 2, browserClosed: false, browserProcessGone: false, serverClosed: false, poolClosed: false, adminClosed: false, scratchRemoved: false };
let failure;
let interrupted = null;
const signals = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => { interrupted ??= signal; void browserServer?.close().catch(() => {}); }]));
for (const [signal, handler] of signals) process.on(signal, handler);
const safeError = error => ({ name: error.name, message: String(error.message).replace(/ly[ori]_[0-9a-f]{64}/giu, '[disposable capability redacted]'), stack: String(error.stack).replace(/ly[ori]_[0-9a-f]{64}/giu, '[disposable capability redacted]') });
const within = async (fn, timeout = 10000) => {
  const end = Date.now() + timeout;
  for (;;) { try { return await fn(); } catch (error) { if (Date.now() >= end) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
};
try {
  scratch = await mkdtemp(join(tmpdir(), 'linky-browser-')); await chmod(scratch, 0o700);
  scratchIdentity = await lstat(scratch);
  await admin.connect();
  const marker = await admin.query("SELECT pg_catalog.shobj_description(oid, 'pg_database') AS marker FROM pg_catalog.pg_database WHERE datname = current_database()");
  assert.equal(marker.rows[0].marker, 'linky-disposable-ci-v1');
  // Authored credentials belong only to this disposable PostgreSQL service.
  await admin.query("ALTER ROLE linky_runtime PASSWORD 'linky-ci-runtime'");
  await admin.query("ALTER ROLE linky_operator PASSWORD 'linky-ci-operator'");
  const runtime = new URL(database); runtime.username = 'linky_runtime'; runtime.password = 'linky-ci-runtime';
  const operator = new URL(database); operator.username = 'linky_operator'; operator.password = 'linky-ci-operator';
  repository = await createPostgresRepository({ connectionString: runtime.href, allowInsecureLoopback: true });
  app = await startServer({ repository });
  browserServer = await chromium.launchServer({ headless: true });
  const browserPid = browserServer.process().pid;
  const browserStat = await readFile(`/proc/${browserPid}/stat`, 'utf8');
  browserPgid = Number(browserStat.slice(browserStat.lastIndexOf(')') + 2).split(' ')[2]);
  assert.equal(browserPgid, browserPid, 'The owned browser must have its own process group.');
  browser = await chromium.connect(browserServer.wsEndpoint());
  for (const [name, viewport, loseAcknowledgment] of [['desktop', { width: 1440, height: 1000 }, true], ['narrow', { width: 390, height: 844 }, false]]) {
    const recoveryFile = join(scratch, `${name}.json`);
    const provision = { name: `Disposable ${name}`, recoveryFile, connectionString: operator.href, allowInsecureLoopback: true };
    const initial = await provisionWorkspace(provision);
    const retry = await provisionWorkspace(provision);
    assert.equal(retry.workspaceId, initial.workspaceId); assert.equal(retry.replayed, true);
    const recovery = JSON.parse(await readFile(recoveryFile, 'utf8'));
    const context = await browser.newContext({ viewport });
    context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(15000);
    const errors = [], unexpected = [], expectedDenials = [], observedDenials = [], consoleDenials = [];
    let expectedNetworkFailures = 0;
    context.on('page', page => {
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') {
        if (message.text().includes('net::ERR_FAILED')) expectedNetworkFailures++;
        else {
          const status = Number(/Failed to load resource: the server responded with a status of (409|410)\b/u.exec(message.text())?.[1]);
          let path; try { const url = new URL(message.location().url); if (url.origin === app.origin) path = url.pathname; } catch {}
          const expected = expectedDenials.filter(row => row.page === page && row.status === status && row.path === path).length;
          const consumed = consoleDenials.filter(row => row.page === page && row.status === status && row.path === path).length;
          if (expected > consumed) consoleDenials.push({ page, status, path });
          else errors.push(message.text());
        }
      } });
      page.on('response', response => {
        if (response.status() === 409 || response.status() === 410) observedDenials.push({ page, status: response.status(), path: new URL(response.url()).pathname });
      });
      page.on('dialog', dialog => dialog.accept());
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== app.origin) { unexpected.push({ origin: url.origin, method: route.request().method() }); await route.abort(); }
      else await route.continue();
    });
    try {
      const owner = await context.newPage();
      await owner.goto(app.origin);
      await owner.locator('#owner-key').fill(recovery.ownerKey);
      await owner.locator('#owner-connect').click();
      await within(async () => assert.match(await owner.locator('#owner-state').textContent(), /Connected to Disposable/u));
      await owner.locator('#open-composer').click();
      await owner.locator('#draft-title').fill(`Owned ${name}`);
      await owner.locator('#draft-destination').fill('https://www.iana.org/domains/reserved?retained=1');
      await owner.locator('#draft-source').fill('authored'); await owner.locator('#draft-medium').fill('browser'); await owner.locator('#draft-campaign').fill(name);
      await owner.locator('#draft-form button[type="submit"]').click();
      await owner.locator('#create-shared').click();
      await owner.getByRole('button', { name: `Manage Owned ${name}`, exact: true }).click();
      await owner.locator('#grant-label').fill(`Recipient ${name}`);
      await owner.locator('#grant-uses').fill('1');
      await owner.locator('#grant-expiry').fill(new Date(Date.now() + 3600000).toISOString());
      await owner.locator('#grant-form button[type="submit"]').click();
      await within(async () => assert.equal(await owner.locator('#copy-grant').isEnabled(), true));
      const share = await owner.locator('#grant-share').inputValue();
      assert.match(new URL(share).hash, /^#lyr_[0-9a-f]{64}$/u);
      // New destination affects the current revision, never an already-issued grant.
      await owner.locator('#revision-title').fill(`Revised ${name}`);
      await owner.locator('#revision-destination').fill('https://www.iana.org/help/example-domains');
      await owner.locator('#revision-form button[type="submit"]').click();
      await owner.locator('#save-revision').click();
      await within(async () => assert.match(await owner.locator('#link-detail').textContent(), new RegExp(`Revised ${name}`)));
      const recipient = await context.newPage(); await recipient.goto(share);
      await within(async () => assert.equal(new URL(recipient.url()).hash, ''));
      assert.equal(await recipient.locator('#recipient-destination').count(), 0);
      const before = await admin.query('SELECT used_count FROM linky_private.grants WHERE id=$1', [new URL(share).pathname.split('/').at(-1)]);
      assert.equal(before.rows[0].used_count, 0);
      await recipient.locator('#recipient-inspect').click();
      await within(async () => assert.equal(await recipient.locator('#recipient-host').textContent(), 'www.iana.org'));
      assert.equal(await recipient.locator('#recipient-destination').count(), 0);
      assert.equal((await admin.query('SELECT used_count FROM linky_private.grants WHERE id=$1', [new URL(share).pathname.split('/').at(-1)])).rows[0].used_count, 0);
      if (loseAcknowledgment) {
        let lost = false;
        await recipient.route('**/api/v1/recipient/redeem', async route => {
          if (!lost) { lost = true; const result = await route.fetch(); assert.equal(result.status(), 200); await route.abort('failed'); }
          else await route.continue();
        });
        await recipient.locator('#recipient-redeem').click();
        await within(async () => assert.equal(await recipient.locator('#recipient-status').textContent(), 'Redemption not confirmed'));
        assert.equal(await recipient.locator('#recipient-destination').count(), 0);
      }
      await recipient.locator('#recipient-redeem').click();
      await within(async () => assert.equal(await recipient.locator('#recipient-destination').count(), 1));
      const target = new URL(await recipient.locator('#recipient-destination').getAttribute('href'));
      assert.equal(target.pathname, '/domains/reserved'); assert.equal(target.searchParams.get('retained'), '1'); assert.equal(target.searchParams.get('utm_campaign'), name);
      await recipient.locator('#recipient-redeem').click();
      await within(async () => assert.equal(await recipient.locator('#recipient-status').textContent(), 'Committed receipt recovered'));
      const count = await admin.query('SELECT used_count FROM linky_private.grants WHERE id=$1', [new URL(share).pathname.split('/').at(-1)]);
      assert.equal(count.rows[0].used_count, 1);
      await owner.locator('#link-state').click(); await owner.getByRole('button', { name: 'Confirm state', exact: true }).click();
      await within(async () => assert.equal(await owner.locator('#link-state').textContent(), 'Activate link'));
      expectedDenials.push({ page: recipient, status: 409, path: '/api/v1/recipient/redeem' });
      await recipient.locator('#recipient-redeem').click();
      await within(async () => assert.equal(await recipient.locator('#recipient-status').textContent(), 'Redemption not confirmed'));
      assert.equal(await recipient.locator('#recipient-destination').count(), 0);
      await owner.locator('#link-state').click(); await owner.getByRole('button', { name: 'Confirm state', exact: true }).click();
      await within(async () => assert.equal(await owner.locator('#link-state').textContent(), 'Pause link'));
      await owner.getByRole('button', { name: `Revoke Recipient ${name}`, exact: true }).click(); await owner.getByRole('button', { name: 'Revoke grant', exact: true }).click();
      await within(async () => assert.match(await owner.locator('.grant-list').textContent(), /· revoked/u));
      expectedDenials.push({ page: recipient, status: 410, path: '/api/v1/recipient/redeem' });
      await recipient.locator('#recipient-redeem').click();
      await within(async () => assert.match(await recipient.locator('#recipient-message').textContent(), /revoked/u));
      assert.equal(await recipient.locator('#recipient-destination').count(), 0);
      await recipient.reload();
      await recipient.locator('#service-notice[data-status="configuration_present"]').waitFor({ state: 'attached' });
      await within(async () => assert.equal(await recipient.locator('#recipient-inspect').isDisabled(), true));
      const storage = await context.storageState(); assert.deepEqual(storage.cookies, []); assert.deepEqual(storage.origins, []);
      await owner.locator('[data-view="attribution"]').click(); await owner.locator('#load-report').click();
      await within(async () => assert.equal(await owner.locator('#report-count').textContent(), '1'));
      const layout = await owner.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.equal(layout.scroll, layout.width);
      await owner.reload();
      await within(async () => assert.match(await owner.locator('#owner-state').textContent(), /credential|Connect|Disconnected/u));
      await owner.locator('#owner-key').fill(recovery.ownerKey); await owner.locator('#owner-connect').click();
      await owner.getByRole('button', { name: `Manage Revised ${name}`, exact: true }).waitFor();
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
      assert.deepEqual(observedDenials.map(({ status, path }) => ({ status, path })), expectedDenials.map(({ status, path }) => ({ status, path })));
      assert.equal(expectedNetworkFailures, loseAcknowledgment ? 1 : 0);
      results.push({ name, viewport, passed: true, lostCommitAcknowledgmentRecovered: loseAcknowledgment, usesCommitted: 1, reportRecords: 1, fragmentRemoved: true, noCredentialStorage: true, immutableGrantDestination: true, pausedReplayDenied: true, revokedReplayDenied: true, layout });
    } finally { await context.close(); lifecycle.contextsClosed++; }
  }
  await browser.close(); lifecycle.browserClosed = true;
  await browserServer.close();
  await within(async () => { let gone = false; try { process.kill(-browserPgid, 0); } catch (error) { gone = error.code === 'ESRCH'; } assert.equal(gone, true); });
  lifecycle.browserProcessGone = true;
} catch (error) { failure = safeError(error); }
finally {
  try { if (browser?.isConnected()) { await browser.close(); lifecycle.browserClosed = true; } await browserServer?.close(); } catch { lifecycle.browserClosed = false; }
  try { await app?.close(); lifecycle.serverClosed = true; } catch {}
  try { await repository?.close(); lifecycle.poolClosed = true; } catch {}
  try { await admin.end(); lifecycle.adminClosed = true; } catch {}
  if (browserPgid) { try { process.kill(-browserPgid, 0); } catch (error) { lifecycle.browserProcessGone = error.code === 'ESRCH'; } }
  if (scratch && !interrupted && lifecycle.browserClosed && lifecycle.browserProcessGone && lifecycle.serverClosed && lifecycle.poolClosed && lifecycle.adminClosed) {
    const current = await lstat(scratch);
    if (current.isDirectory() && !current.isSymbolicLink() && current.dev === scratchIdentity.dev && current.ino === scratchIdentity.ino && current.uid === scratchIdentity.uid) {
      await rm(scratch, { recursive: true }); lifecycle.scratchRemoved = true;
    }
  }
  for (const [signal, handler] of signals) process.removeListener(signal, handler);
}
console.log(JSON.stringify({ browserVersion: browser?.version(), results, lifecycle, interrupted, ...(failure ? { failure } : {}) }));
if (failure || interrupted || results.length !== 2 || !Object.values(lifecycle).every(Boolean) || lifecycle.contextsClosed !== 2) process.exitCode = 1;
