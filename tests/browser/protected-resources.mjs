import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { Readable } from 'node:stream';
import { readFile, writeFile, mkdtemp, chmod, rm, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pools, runtimeUrl } from '../fixtures/origin-db.mjs';
import { createPostgresRepository } from '../../server/postgres.mjs';
import { createHandler } from '../../server/http.mjs';
import { createProtectedResource } from '../../server/protected-resource.mjs';
import { generateCapability, hashCapability } from '../../server/capabilities.mjs';

const origin = 'https://linky.example.com', resourceOrigin = 'https://resource.example.com';
const bytes = Buffer.from('Authored disposable private resource. No real family, customer or account data.\n');
const sha = value => createHash('sha256').update(value).digest('hex');
const evidence = process.env.RUNNER_TEMP + '/linky-origin-evidence';
const safeError = error => ({ name: error.name, message: String(error.message).replace(/ly[oripa]_[0-9a-f]{64}/giu, '[disposable capability redacted]'), stack: String(error.stack).replace(/ly[oripa]_[0-9a-f]{64}/giu, '[disposable capability redacted]') });
const eventually = async read => { const end = Date.now() + 10000; for (;;) { try { return await read(); } catch (error) { if (Date.now() >= end) throw error; await delay(40); } } };
const guards = new Map(), observed = new Map();
let db, repository, server, browserServer, browser, pgid, scratch, scratchIdentity, failure, interrupted;
const contexts = [], results = [], downloads = [], screenshots = [], pageErrors = [], unexpectedOrigins = [];
const lifecycle = { contextsCreated: 0, contextsClosed: 0, browserClosed: false, browserGroupGone: false, serverClosed: false, poolClosed: false, databaseClosed: false, scratchRemoved: false };
const signals = new Map(['SIGINT','SIGTERM','SIGHUP'].map(signal => [signal, () => { interrupted ??= signal; void browserServer?.close().catch(() => {}); }]));
for (const [name, handler] of signals) process.on(name, handler);
try {
  db = await pools(); repository = await createPostgresRepository({ connectionString: runtimeUrl, allowInsecureLoopback: true });
  const api = createHandler({ origin, repository });
  scratch = await mkdtemp(process.env.RUNNER_TEMP + '/linky-origin-browser-'); await chmod(scratch, 0o700); scratchIdentity = await lstat(scratch);
  const staticFiles = new Map();
  for (const name of ['index.html','styles.css','icon.svg','src/app.mjs','src/ui.mjs','src/destinations.mjs','src/attribution.mjs','src/server-client.mjs','src/resource-client.mjs']) staticFiles.set('/' + name, await readFile(new URL('../../public/' + name, import.meta.url)));
  server = createServer({ cert: await readFile(process.env.LINKY_CI_CERT), key: await readFile(process.env.LINKY_CI_KEY) }, async (incoming, outgoing) => {
    try {
      const host = incoming.headers.host;
      if (!['linky.example.com','resource.example.com'].includes(host)) { outgoing.writeHead(421); outgoing.end(); return; }
      const url = new URL(incoming.url, 'https://' + host), controller = new AbortController();
      outgoing.on('close', () => controller.abort());
      const input = new Request(url, { method: incoming.method, headers: incoming.headers,
        ...(['POST'].includes(incoming.method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}), signal: controller.signal });
      let response;
      if (host === 'resource.example.com') {
        const guard = guards.get(url.href);
        if (guard && incoming.method !== 'OPTIONS') {
          const secret = incoming.headers.authorization;
          assert(!secret || /^Bearer lya_[0-9a-f]{64}$/u.test(secret));
          observed.set(url.href, { accessKey: secret?.slice(7), accessId: incoming.headers['x-linky-access-id'], cookie: incoming.headers.cookie });
        }
        response = guard ? await guard(input) : new Response('', { status: 404 });
      } else if (url.pathname.startsWith('/api/v1/')) response = await api(input);
      else {
        const path = url.pathname === '/' || /^\/r\/[0-9a-f-]{36}\/?$/u.test(url.pathname) ? '/index.html' : url.pathname;
        const file = staticFiles.get(path);
        response = file && !url.search ? new Response(file, { headers: { 'content-type': path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/html', 'cache-control': 'no-store' } }) : new Response('', { status: 404 });
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).on('error', () => outgoing.destroy()).pipe(outgoing); else outgoing.end();
    } catch { outgoing.writeHead(500, { 'cache-control': 'no-store' }); outgoing.end(); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.maxHeadersCount = 50;
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(443, '127.0.0.1', resolveListen); });
  const { chromium } = await import(pathToFileURL(process.env.LINKY_PLAYWRIGHT_MODULE).href);
  browserServer = await chromium.launchServer({ headless: true, args: ['--no-proxy-server'] });
  const pid = browserServer.process().pid, stat = await readFile(`/proc/${pid}/stat`, 'utf8'); pgid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]); assert.equal(pgid, pid);
  browser = await chromium.connect(browserServer.wsEndpoint());
  const context = async narrow => {
    const value = await browser.newContext({ viewport: narrow ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, ignoreHTTPSErrors: true, acceptDownloads: true });
    contexts.push(value); lifecycle.contextsCreated++; value.setDefaultTimeout(10000); value.setDefaultNavigationTimeout(15000);
    await value.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (![origin, resourceOrigin].includes(url.origin)) { unexpectedOrigins.push(url.origin); await route.abort(); } else await route.continue();
    });
    value.on('page', page => { page.on('dialog', dialog => dialog.accept()); page.on('pageerror', error => pageErrors.push(safeError(error))); }); return value;
  };
  const openOwner = async (w, l, narrow) => {
    const ctx = await context(narrow), page = await ctx.newPage(); await page.goto(origin);
    await page.locator('#owner-key').fill(w.key); await page.locator('#owner-connect').click();
    await eventually(async () => assert.match(await page.locator('#owner-state').textContent(), /Connected to/u));
    await page.getByRole('button', { name: 'Manage Authored protected file', exact: true }).click();
    await page.locator('#origin-form').waitFor();
    await eventually(async () => assert.equal(await page.locator('#issue-origin').isEnabled(), true)); return page;
  };
  const register = c => {
    guards.set(c.resourceUrl, createProtectedResource({ linkyOrigin: origin, credentialId: c.credentialId, originKey: c.key, resourceUrl: c.resourceUrl }, request => {
      assert.equal(request.headers.has('authorization'), false); assert.equal(request.headers.has('cookie'), false);
      return new Response(request.method === 'HEAD' ? null : bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) } });
    }));
  };
  const seed = async name => {
    const w = await db.workspace(), l = await db.link(w, resourceOrigin + '/private.bin?case=' + name);
    const key = generateCapability('recipient'), digest = hashCapability(key, 'recipient'), grantId = randomUUID();
    const grant = await db.call('owner_issue_grant', w.hash, { workspaceId: w.id, linkId: l.linkId, revisionId: l.revisionId, mutationKey: randomUUID(), expectedVersion: l.version, grantId, recipientHash: digest, label: 'Authored browser recipient', maxUses: 1, expiresAt: new Date(Date.now() + 300000).toISOString() });
    return { w, l: { ...l, version: grant.version }, grantId, recipientKey: key };
  };
  const openRecipient = async (fixture, narrow) => {
    const ctx = await context(narrow), page = await ctx.newPage();
    await page.goto(origin + '/r/' + fixture.grantId + '#' + fixture.recipientKey); assert.equal(new URL(page.url()).hash, '');
    await eventually(async () => assert.equal(await page.locator('#recipient-inspect').isEnabled(), true)); await page.locator('#recipient-inspect').click();
    await eventually(async () => assert.equal(await page.locator('#recipient-redeem').isEnabled(), true)); await page.locator('#recipient-redeem').click();
    await page.locator('#inspect-resource').waitFor(); assert.equal(await page.locator('#recipient-usage').textContent(), 'Inspect again');
    await page.locator('#inspect-resource').click(); await page.locator('#prepare-resource').waitFor(); return page;
  };
  const download = async (page, name) => {
    const pending = page.waitForEvent('download'); await page.locator('#download-resource').click(); const file = await pending;
    const path = join(evidence, name + '.bin'); await file.saveAs(path); const saved = await readFile(path); assert.deepEqual(saved, bytes);
    downloads.push({ path: name + '.bin', bytes: saved.length, sha256: sha(saved) });
    await eventually(async () => assert.match(await page.locator('#resource-message').textContent(), /Downloaded/u));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'download-resource');
  };
  const shot = async (page, name) => {
    const path = join(evidence, name + '.png'); await page.screenshot({ path, fullPage: true, mask: [page.locator('#owner-key'), page.locator('#origin-config'), page.locator('#grant-share'), page.locator('#conversion-key')] });
    const data = await readFile(path); screenshots.push({ path: name + '.png', bytes: data.length, sha256: sha(data) });
  };
  const count = async fixture => (await db.admin.query('SELECT used_count,(SELECT count(*)::int FROM linky_private.redemption_receipts WHERE grant_id=$1) receipts FROM linky_private.grants WHERE id=$1', [fixture.grantId])).rows[0];

  let stage = 'B01 owner host issue';
  try {
    const f = await seed('B01'), owner = await openOwner(f.w, f.l, false);
    await owner.locator('#origin-label').fill('Browser host'); await owner.locator('#issue-origin').click();
    await eventually(async () => assert.equal(await owner.locator('#download-origin-config').isEnabled(), true));
    const pending = owner.waitForEvent('download'); await owner.locator('#download-origin-config').click(); const file = await pending;
    const privatePath = join(scratch, 'host-config.json'); await file.saveAs(privatePath); await chmod(privatePath, 0o600);
    const config = JSON.parse(await readFile(privatePath, 'utf8')); assert.equal(config.resourceUrl, f.l.payload.destination); assert.equal(config.linkyOrigin, origin);
    register({ ...config, key: config.originKey }); await rm(privatePath);
    stage = 'B01 real protected download';
    const recipient = await openRecipient(f, false); await recipient.locator('#prepare-resource').click(); await recipient.locator('#download-resource').waitFor();
    await download(recipient, 'B01-first'); await download(recipient, 'B01-repeat'); assert.deepEqual(await count(f), { used_count: 1, receipts: 1 });
    const seen = observed.get(config.resourceUrl); assert.equal(seen.cookie, undefined); assert(/^lya_/u.test(seen.accessKey));
    const head = await fetch(config.resourceUrl, { method: 'HEAD', headers: { Authorization: 'Bearer ' + seen.accessKey, 'X-Linky-Access-Id': seen.accessId }, signal: AbortSignal.timeout(5000) }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.equal((await fetch(config.resourceUrl, { signal: AbortSignal.timeout(5000) })).status, 401);
    assert.equal((await fetch(resourceOrigin + '/public/private.bin', { signal: AbortSignal.timeout(5000) })).status, 404);
    stage = 'B01 grant revoke';
    await owner.getByRole('button', { name: 'Revoke Authored browser recipient', exact: true }).click(); await owner.getByRole('button', { name: 'Revoke grant', exact: true }).click();
    await eventually(async () => assert.match(await owner.locator('#notice-text').textContent(), /Revoke recipient grant confirmed/u));
    await recipient.locator('#download-resource').click(); await eventually(async () => assert.match(await recipient.locator('#resource-message').textContent(), /refused/u));
    assert.deepEqual(await count(f), { used_count: 1, receipts: 1 }); await shot(recipient, 'B01-desktop-revoked');
    results.push({ id: 'B01', passed: true, purpose: 'desktop host export, real downloads, GET/HEAD accounting and learned URL denied after grant revoke' });
  } catch (error) { throw new Error(stage, { cause: error }); }

  stage = 'B02 lost owner acknowledgment';
  try {
    const f = await seed('B02'), c = await db.credential(f.w, f.l); register(c);
    const owner = await openOwner(f.w, f.l, true), bodies = []; let lost = false;
    await owner.route('**/api/v1/origin-credentials/issue', async route => {
      bodies.push(route.request().postData()); if (!lost) { lost = true; const reply = await route.fetch(); assert.equal(reply.status(), 200); await route.abort('failed'); } else await route.continue();
    });
    await owner.locator('#origin-label').fill('Lost reply host'); await owner.locator('#issue-origin').click();
    await eventually(async () => assert.match(await owner.locator('#mutation-recovery-message').textContent(), /uncertain/u));
    const before = await owner.locator('#origin-config').inputValue(); assert.equal(await owner.locator('#download-origin-config').isEnabled(), false);
    await owner.locator('#mutation-retry').click(); await eventually(async () => assert.equal(await owner.locator('#download-origin-config').isEnabled(), true));
    assert.equal(bodies.length, 2); assert(bodies[0] === bodies[1]); assert((await owner.locator('#origin-config').inputValue()) === before);
    const credentialId = JSON.parse(before).credentialId; assert.equal((await db.admin.query('SELECT count(*)::int n FROM linky_private.origin_credentials WHERE id=$1', [credentialId])).rows[0].n, 1);
    stage = 'B02 lost resource acknowledgment';
    const recipient = await openRecipient(f, true), preparations = []; let prepareLost = false;
    await recipient.route('**/api/v1/recipient/resource-prepare', async route => {
      preparations.push(route.request().postData()); if (!prepareLost) { prepareLost = true; const reply = await route.fetch(); assert.equal(reply.status(), 200); await route.abort('failed'); } else await route.continue();
    });
    await recipient.locator('#prepare-resource').click(); await recipient.locator('#retry-resource').waitFor();
    await eventually(async () => assert.match(await recipient.locator('#resource-message').textContent(), /kept/u));
    assert.equal(await recipient.locator('#inspect-resource').isDisabled(), true); assert.equal(await recipient.locator('#download-resource').count(), 0);
    await recipient.locator('#retry-resource').click(); await recipient.locator('#download-resource').waitFor(); assert.equal(preparations.length, 2); assert(preparations[0] === preparations[1]);
    await download(recipient, 'B02-recovered'); assert.deepEqual(await count(f), { used_count: 1, receipts: 1 }); await shot(recipient, 'B02-narrow-recovered');
    results.push({ id: 'B02', passed: true, purpose: 'narrow owner and recipient lost-reply retries retain exact key, body, ID and version' });
  } catch (error) { throw new Error(stage, { cause: error }); }

  stage = 'B03 explicit resource replacement';
  try {
    const f = await seed('B03'), c = await db.credential(f.w, f.l); register(c); const recipient = await openRecipient(f, false);
    await recipient.locator('#prepare-resource').click(); await recipient.locator('#download-resource').waitFor(); await download(recipient, 'B03-original');
    const previous = { ...observed.get(c.resourceUrl) };
    await recipient.getByRole('button', { name: 'Clear resource key from tab', exact: true }).click(); await recipient.getByRole('button', { name: 'Clear resource key', exact: true }).click();
    await recipient.locator('#inspect-resource').click(); await recipient.locator('#prepare-resource').waitFor();
    await recipient.locator('#prepare-resource').click(); await recipient.getByRole('button', { name: 'Replace resource access', exact: true }).click(); await recipient.locator('#download-resource').waitFor();
    assert.equal((await fetch(c.resourceUrl, { headers: { Authorization: 'Bearer ' + previous.accessKey, 'X-Linky-Access-Id': previous.accessId }, signal: AbortSignal.timeout(5000) })).status, 403);
    await download(recipient, 'B03-replacement'); assert.deepEqual(await count(f), { used_count: 1, receipts: 1 });
    const owner = await openOwner(f.w, f.l, false); await owner.locator('#link-state').click(); await owner.getByRole('button', { name: 'Confirm state', exact: true }).click();
    await eventually(async () => assert.match(await owner.locator('#notice-text').textContent(), /Change link state confirmed/u));
    await recipient.locator('#download-resource').click(); await eventually(async () => assert.match(await recipient.locator('#resource-message').textContent(), /refused/u)); await shot(recipient, 'B03-desktop-paused');
    results.push({ id: 'B03', passed: true, purpose: 'explicit replacement invalidates prior access and paused links deny the known resource' });
  } catch (error) { throw new Error(stage, { cause: error }); }

  stage = 'B04 host credential revocation and expiry';
  try {
    const f = await seed('B04'), c = await db.credential(f.w, f.l); register(c); const recipient = await openRecipient(f, true);
    await recipient.locator('#prepare-resource').click(); await recipient.locator('#download-resource').waitFor(); await download(recipient, 'B04-initial');
    const revoked = await db.call('owner_revoke_origin_credential', f.w.hash, { workspaceId: f.w.id, linkId: f.l.linkId, credentialId: c.credentialId, mutationKey: randomUUID(), expectedVersion: c.version });
    await recipient.locator('#download-resource').click(); await eventually(async () => assert.match(await recipient.locator('#resource-message').textContent(), /refused/u));
    const expiresAt = new Date(Date.now() + 1600).toISOString(); const short = await db.credential(f.w, { ...f.l, version: revoked.version }, { expiresAt }); register(short);
    await download(recipient, 'B04-before-expiry'); await delay(Math.max(0, Date.parse(expiresAt) - Date.now() + 100));
    await recipient.locator('#download-resource').click(); await eventually(async () => assert.match(await recipient.locator('#resource-message').textContent(), /refused/u));
    assert.deepEqual(await count(f), { used_count: 1, receipts: 1 });
    assert.equal(await recipient.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await shot(recipient, 'B04-narrow-expired');
    results.push({ id: 'B04', passed: true, purpose: 'narrow host revocation and real wall-clock expiry deny repeated access without a new use' });
  } catch (error) { throw new Error(stage, { cause: error }); }
  assert.deepEqual(pageErrors, []); assert.deepEqual(unexpectedOrigins, []);
} catch (error) {
  failure = safeError(error); if (error.cause) failure.cause = safeError(error.cause);
} finally {
  for (const ctx of contexts) { try { await ctx.close(); lifecycle.contextsClosed++; } catch {} }
  try { if (browser?.isConnected()) await browser.close(); await browserServer?.close(); lifecycle.browserClosed = Boolean(browserServer); } catch {}
  if (pgid) { try { await eventually(async () => { let gone = false; try { process.kill(-pgid, 0); } catch (error) { gone = error.code === 'ESRCH'; } assert(gone); }); lifecycle.browserGroupGone = true; } catch {} }
  try { if (server) { await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); }); lifecycle.serverClosed = true; } } catch {}
  try { await repository?.close(); lifecycle.poolClosed = Boolean(repository); } catch {}
  try { await db?.close(); lifecycle.databaseClosed = Boolean(db); } catch {}
  if (scratch && !interrupted && lifecycle.browserClosed && lifecycle.browserGroupGone && lifecycle.serverClosed && lifecycle.poolClosed && lifecycle.databaseClosed && lifecycle.contextsClosed === lifecycle.contextsCreated) {
    const identity = await lstat(scratch); assert.equal(identity.dev, scratchIdentity.dev); assert.equal(identity.ino, scratchIdentity.ino); assert(identity.isDirectory() && !identity.isSymbolicLink()); assert(resolve(scratch).startsWith(process.env.RUNNER_TEMP + '/linky-origin-browser-'));
    await rm(scratch, { recursive: true }); lifecycle.scratchRemoved = true;
  }
  for (const [name, handler] of signals) process.removeListener(name, handler);
}
const passed = !failure && !interrupted && results.length === 4 && results.every(row => row.passed) && Object.entries(lifecycle).filter(([key]) => !['contextsCreated','contextsClosed'].includes(key)).every(([, value]) => value === true) && lifecycle.contextsCreated === lifecycle.contextsClosed;
const receipt = { node: process.version, browserVersion: browser?.version(), results, downloads, screenshots, pageErrors, unexpectedOrigins, lifecycle, interrupted: interrupted ?? null, failure: failure ?? null, passed };
await writeFile(evidence + '/browser.json', JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(receipt)); if (!passed) process.exitCode = 1;
