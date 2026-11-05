import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withExtensionFixture, eventually } from './fixture.mjs';

await withExtensionFixture(async ({ admin, app, results, createWorkspace, createContext, afterClose }) => {
  for (const [name, viewport, validRows, loseReply] of [['desktop', { width: 1440, height: 1000 }, 51, true], ['narrow', { width: 390, height: 844 }, 3, false]]) {
    const workspace = await createWorkspace(`extension-${name}`), context = await createContext(viewport);
    const errors = [], unexpected = [], batches = []; let lost = false, expectedNetworkFailures = 0, stage = 'open owner';
    context.on('page', page => {
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') {
        if (message.text().includes('net::ERR_FAILED')) expectedNetworkFailures++; else errors.push(message.text());
      } });
    });
    afterClose(() => {
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
      assert.equal(expectedNetworkFailures, loseReply ? 1 : 0);
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== app.origin) { unexpected.push({ origin: url.origin, method: route.request().method() }); await route.abort(); }
      else await route.continue();
    });
    const owner = await context.newPage();
    const readCount = async () => (await admin.query('SELECT count(*)::int AS n FROM linky_private.links WHERE workspace_id=$1', [workspace.workspaceId])).rows[0].n;
    const connect = async () => {
      await owner.locator('#owner-key').fill(workspace.ownerKey); await owner.locator('#owner-connect').click();
      await eventually(async () => assert.match(await owner.locator('#owner-state').textContent(), /Connected to extension-/u));
    };
    const issueCredential = async label => {
      await owner.locator('#conversion-label').fill(label);
      await owner.locator('#conversion-expiry').fill(new Date(Date.now() + 3600000).toISOString());
      await owner.locator('#issue-conversion').click();
      await eventually(async () => assert.equal(await owner.locator('#copy-conversion-key').isEnabled(), true));
      const key = await owner.locator('#conversion-key').inputValue();
      const id = (await owner.locator('#conversion-credential-id').textContent()).trim();
      assert.match(key, /^lyi_[0-9a-f]{64}$/u); assert.match(id, /^[0-9a-f-]{36}$/u);
      return { key, id };
    };
    const declare = async (credential, input, status = 200) => {
      const response = await fetch(app.origin + '/api/v1/conversions/ingest', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential.key },
        body: JSON.stringify({ ...input, credentialId: credential.id }), redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result));
      assert.equal(JSON.stringify(result).includes(credential.key), false);
      return result;
    };
    try {
      await owner.goto(app.origin); await connect();
      stage = 'prepare actual CSV';
      const title = `Imported ${name} 000`;
      const csv = ['title,destination,source,medium,campaign',
        ...Array.from({ length: validRows }, (_, index) => `Imported ${name} ${String(index).padStart(3,'0')},https://www.iana.org/domains/reserved?row=${index},authored,ci,extension-${name}`),
        `Blocked ${name},javascript:alert(1),authored,ci,extension-${name}`].join('\n');
      await owner.locator('#open-bulk').click(); await owner.locator('#bulk-source').fill(csv);
      await owner.locator('#bulk-form button[type="submit"]').click();
      await owner.route('**/api/v1/links/bulk-create', async route => {
        const raw = route.request().postData(); batches.push(raw);
        assert(Buffer.byteLength(raw) <= 32768); assert(JSON.parse(raw).rows.length <= 50);
        if (loseReply && !lost) { lost = true; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed'); }
        else await route.continue();
      });
      stage = 'save reviewed CSV';
      await owner.locator('#bulk-save-reviewed').click(); await owner.getByRole('button', { name: 'Save valid rows', exact: true }).click();
      if (loseReply) {
        await owner.locator('#bulk-retry').waitFor({ state: 'visible' });
        await eventually(async () => assert.equal(await owner.locator('#bulk-retry').isEnabled(), true));
        assert.equal(await readCount(), 50);
        stage = 'recover exact committed CSV batch';
        await owner.locator('#bulk-retry').click();
        await eventually(async () => assert.equal(await owner.locator('#bulk-resume').isVisible(), true));
        assert.equal(batches[0], batches[1]); assert.equal(await readCount(), 50);
        await owner.locator('#bulk-resume').click();
      }
      await eventually(async () => assert.equal(await readCount(), validRows));
      await eventually(async () => assert.match(await owner.locator('#bulk-progress').textContent(), /1 invalid/u));
      await eventually(async () => assert.match(await owner.locator('#bulk-progress').textContent(), /· 0 awaiting confirmation\./u));
      await eventually(async () => assert.equal(await owner.locator('#close-bulk').isEnabled(), true));
      await owner.locator('#close-bulk').click();
      stage = 'reload durable CSV records';
      await owner.reload(); await connect(); await owner.locator('[data-view="links"]').click();
      await owner.locator('#registry-search').fill(title);
      let releaseRefresh, observedRefresh;
      const responseGate = new Promise(resolve => { releaseRefresh = resolve; });
      const refreshObserved = new Promise(resolve => { observedRefresh = resolve; });
      let holdOneRefresh = true;
      await owner.route('**/api/v1/links/list', async route => {
        if (!holdOneRefresh) { await route.continue(); return; }
        holdOneRefresh = false;
        const response = await route.fetch(); observedRefresh(); await responseGate;
        await route.fulfill({ response });
      });
      let refreshTimer;
      try {
        await owner.locator('#refresh-workspace').click();
        await Promise.race([refreshObserved, new Promise((_, reject) => { refreshTimer = setTimeout(() => reject(new Error('Refresh request was not observed.')), 10000); })]);
        const controls = owner.locator('#registry-body button'); assert((await controls.count()) > 0);
        for (const control of await controls.all()) assert.equal(await control.isDisabled(), true);
      } finally { clearTimeout(refreshTimer); releaseRefresh(); }
      await owner.getByRole('button', { name: 'Manage ' + title, exact: true }).click();
      stage = 'issue recipient and ingest credentials';
      await owner.locator('#grant-label').fill(`Recipient ${name}`); await owner.locator('#grant-uses').fill('1');
      await owner.locator('#grant-expiry').fill(new Date(Date.now() + 3600000).toISOString());
      await owner.locator('#grant-form button[type="submit"]').click();
      await eventually(async () => assert.equal(await owner.locator('#copy-grant').isEnabled(), true));
      const share = await owner.locator('#grant-share').inputValue();
      const first = await issueCredential(`Integration first ${name}`);
      const recipient = await context.newPage(); await recipient.goto(share);
      await recipient.locator('#recipient-inspect').click(); await recipient.locator('#recipient-redeem').click();
      await eventually(async () => assert.equal(await recipient.locator('#recipient-destination').count(), 1));
      const receiptId = /Receipt ([0-9a-f-]{36})/u.exec(await recipient.locator('#recipient-result').textContent())?.[1]; assert(receiptId);
      assert.equal(new URL(recipient.url()).hash, '');
      stage = 'authenticated declarations';
      const base = { receiptId, declaredAt: new Date().toISOString() };
      const lead = { ...base, eventKey: randomUUID(), kind: 'lead_declared', amountMinor: null, currency: null };
      const usd = { ...base, eventKey: randomUUID(), kind: 'sale_declared', amountMinor: Number.MAX_SAFE_INTEGER, currency: 'USD' };
      const leadAck = await declare(first, lead); const duplicate = await declare(first, lead);
      assert.equal(leadAck.eventId, duplicate.eventId); assert.equal(duplicate.replayed, true);
      const originalSale = await declare(first, usd);
      await owner.getByRole('button', { name: 'Clear private conversion key', exact: true }).click();
      await owner.getByRole('button', { name: 'Clear private key', exact: true }).click();
      const second = await issueCredential(`Integration second ${name}`);
      await owner.getByRole('button', { name: `Revoke conversion Integration first ${name}`, exact: true }).click();
      await owner.getByRole('button', { name: 'Revoke conversion credential', exact: true }).click();
      await owner.getByRole('button', { name: `Revoke conversion Integration first ${name}`, exact: true }).waitFor({ state: 'detached' });
      assert.equal((await admin.query('SELECT revoked_at IS NOT NULL AS revoked FROM linky_private.conversion_credentials WHERE id=$1 AND workspace_id=$2', [first.id, workspace.workspaceId])).rows[0].revoked, true);
      await declare(first, usd, 410);
      const rotated = await declare(second, usd); assert.equal(rotated.eventId, originalSale.eventId); assert.equal(rotated.replayed, true);
      await declare(second, { ...usd, eventKey: randomUUID() });
      await declare(second, { ...usd, eventKey: randomUUID(), amountMinor: 7, currency: 'JPY' });
      await declare(second, { ...usd, eventKey: randomUUID(), amountMinor: null, currency: null });
      const eventRows = (await admin.query('SELECT count(*)::int AS n FROM linky_private.conversion_events WHERE workspace_id=$1', [workspace.workspaceId])).rows[0].n;
      assert.equal(eventRows, 5);
      stage = 'actual declaration report';
      await owner.locator('[data-view="attribution"]').click(); await owner.locator('#load-attribution-report').click();
      for (const [id, expected] of [['redemptions','1'],['leads','1'],['sales','4'],['unknown-sales','1']]) await eventually(async () => assert.equal(await owner.locator('#attribution-' + id).textContent(), expected));
      assert.equal(await owner.locator('.currency-total[data-currency="USD"] .minor-unit-total').textContent(), '18014398509481982');
      assert.equal(await owner.locator('.currency-total[data-currency="JPY"] .minor-unit-total').textContent(), '7');
      const layout = await owner.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth })); assert.equal(layout.scroll, layout.width);
      const storage = await context.storageState(); assert.deepEqual(storage.cookies, []); assert.deepEqual(storage.origins, []);
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.equal(expectedNetworkFailures, loseReply ? 1 : 0);
      results.push({ name, viewport, passed: true, persistedCsvRows: validRows, invalidRowsExcluded: 1, batchSizes: batches.map(x => JSON.parse(x).rows.length), uncertainBatchRecovered: loseReply,
        exactBodyReused: loseReply ? batches[0] === batches[1] : null, refreshControlsDisabled: true, declarationsCommitted: 5, rotatedReplaySameEvent: true, revokedKeyReplayDenied: true, exactUsdMinorTotal: '18014398509481982', exactJpyMinorTotal: '7', noCredentialStorage: true, layout });
    } catch (error) { error.message = `${name} / ${stage}: ${error.message}`; throw error; }
  }
});
