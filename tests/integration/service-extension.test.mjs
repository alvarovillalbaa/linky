import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const expectedUrl = 'postgresql://postgres:authored-ci-only@127.0.0.1:5432/linky_extension_checks';
if (process.env.CI !== 'true' || process.env.LINKY_DISPOSABLE_DATABASE !== 'true'
    || process.env.LINKY_DISPOSABLE_DB !== 'linky-pg17-extension-v2' || process.env.LINKY_TEST_DATABASE_URL !== expectedUrl) {
  throw new Error('linky_extension_disposable_database_required');
}
const { default: pg } = await import('pg');
const options = { max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000,
  statement_timeout: 12000, lock_timeout: 8000, application_name: 'linky-extension-disposable' };
const admin = new pg.Pool({ ...options, connectionString: expectedUrl });
let runtime, operator, seeded, beforeMigration, afterMigration;
const v1Functions = ['owner_connect', 'owner_rotate', 'owner_close', 'owner_create_link', 'owner_revise_link', 'owner_set_link_state',
  'owner_issue_grant', 'owner_revoke_grant', 'owner_list_links', 'owner_list_grants', 'recipient_inspect', 'recipient_redeem', 'owner_report'];
const v2Functions = ['owner_issue_conversion_credential', 'owner_list_conversion_credentials', 'owner_revoke_conversion_credential',
  'conversion_ingest', 'owner_bulk_create_links', 'owner_attribution_report'];
const functions = new Set([...v1Functions, ...v2Functions]);
const hash = value => createHash('sha256').update(value).digest('hex');
const capability = purpose => hash(`${purpose}_${randomUUID()}_${randomUUID()}`);
const campaign = { source: 'authored', medium: 'extension-ci', campaign: 'initial' };
const safety = { policyVersion: 'linky-address-v1', hostname: 'www.iana.org', result: 'accepted', reputation: 'unchecked' };
async function call(name, digest, payload, client = runtime) {
  assert.ok(functions.has(name));
  return (await client.query(`SELECT linky_private.${name}($1::text,$2::jsonb) AS result`, [digest, JSON.stringify(payload)])).rows[0].result;
}
const denied = (work, code) => assert.rejects(work, error => error.code === 'P0001' && error.message === code);
async function workspace() {
  const w = { id: randomUUID(), hash: capability('lyo') };
  await operator.query('SELECT linky_private.operator_provision($1::uuid,$2::jsonb)', [randomUUID(), JSON.stringify({ workspaceId: w.id, mutationKey: randomUUID(), name: 'Authored V2 workspace', ownerHash: w.hash })]);
  return w;
}
function row(sourceIndex = 0, overrides = {}) {
  return { sourceIndex, mutationKey: randomUUID(), linkId: randomUUID(), revisionId: randomUUID(), slug: `v2_${randomUUID()}`,
    label: 'Authored V2 link', destination: 'https://www.iana.org/domains/reserved', campaign: { ...campaign }, safety: { ...safety }, ...overrides };
}
async function link(w, overrides = {}) {
  const { sourceIndex: _, ...payload } = row(0, overrides);
  const ack = await call('owner_create_link', w.hash, { workspaceId: w.id, ...payload });
  return { ...ack, payload: { workspaceId: w.id, ...payload } };
}
async function receipt(w, l, expiry = new Date(Date.now() + 60000).toISOString()) {
  const recipientHash = capability('lyr'), grantId = randomUUID(), key = randomUUID();
  const issued = await call('owner_issue_grant', w.hash, { workspaceId: w.id, mutationKey: randomUUID(), linkId: l.linkId, revisionId: l.revisionId,
    expectedVersion: l.version, grantId, recipientHash, label: 'Authored receipt', maxUses: 1, expiresAt: expiry });
  const ack = await call('recipient_redeem', recipientHash, { grantId, redemptionKey: key });
  return { ...ack, grantId, recipientHash, key, linkVersion: issued.version, expiresAt: expiry };
}
async function credential(w, l, overrides = {}) {
  const digest = capability('lyi');
  const payload = { workspaceId: w.id, mutationKey: randomUUID(), linkId: l.linkId, revisionId: l.revisionId, expectedVersion: l.version,
    credentialId: randomUUID(), ingestHash: digest, label: 'Authored conversion source', expiresAt: new Date(Date.now() + 60000).toISOString(), ...overrides };
  const ack = await call('owner_issue_conversion_credential', w.hash, payload);
  return { ...ack, hash: digest, payload };
}
async function cohort() {
  const w = await workspace(), l = await link(w), r = await receipt(w, l), c = await credential(w, { ...l, version: r.linkVersion });
  return { w, l, r, c };
}
function event(c, r, overrides = {}) {
  return { credentialId: c.credentialId, receiptId: r.receiptId, eventKey: randomUUID(), kind: 'lead_declared',
    amountMinor: null, currency: null, declaredAt: '2020-01-01T00:00:00.000Z', ...overrides };
}
const ingest = (c, payload, client) => call('conversion_ingest', c.hash, payload, client);
const report = (w, options = {}) => call('owner_attribution_report', w.hash, { workspaceId: w.id, from: null, to: null, limit: 50, ...options });
const bulk = (w, rows) => call('owner_bulk_create_links', w.hash, { workspaceId: w.id, rows });
async function conversionCounts(w) {
  return (await admin.query(`SELECT
    (SELECT count(*)::int FROM linky_private.conversion_events WHERE workspace_id=$1) events,
    (SELECT count(*)::int FROM linky_private.audit_events WHERE workspace_id=$1 AND action='conversion_ingest') audits`, [w.id])).rows[0];
}
async function snapshot(w) {
  const result = {};
  for (const table of ['workspaces','links','destination_revisions','grants','redemption_receipts','attribution_events','mutation_receipts','audit_events']) {
    result[table] = (await admin.query(`SELECT to_jsonb(x) value FROM linky_private.${table} x WHERE ${table === 'workspaces' ? 'id' : 'workspace_id'}=$1 ORDER BY id`, [w.id])).rows.map(x => x.value);
  }
  return result;
}
before(async () => {
  const target = (await admin.query(`SELECT current_database() name,current_setting('server_version_num')::int version,
    shobj_description(oid,'pg_database') marker FROM pg_catalog.pg_database WHERE datname=current_database()`)).rows[0];
  assert.deepEqual({ name: target.name, major: Math.floor(target.version / 10000), marker: target.marker },
    { name: 'linky_extension_checks', major: 17, marker: 'linky-extension-disposable-ci-v2' });
  await admin.query(await readFile(new URL('../../db/bootstrap.sql', import.meta.url), 'utf8'));
  const v1 = await readFile(new URL('../../supabase/migrations/20261105080045_linky_initial_service.sql', import.meta.url));
  assert.equal(hash(v1), '406957876504aeb4c99a42f6488f24c325aaf9c2e41b8dc501f5c227b08249be');
  await admin.query(v1.toString('utf8'));
  await admin.query("ALTER ROLE linky_runtime PASSWORD 'authored-runtime-only'; ALTER ROLE linky_operator PASSWORD 'authored-operator-only'");
  runtime = new pg.Pool({ ...options, connectionString: 'postgresql://linky_runtime:authored-runtime-only@127.0.0.1:5432/linky_extension_checks' });
  operator = new pg.Pool({ ...options, max: 2, connectionString: 'postgresql://linky_operator:authored-operator-only@127.0.0.1:5432/linky_extension_checks' });
  const w = await workspace(), l = await link(w), r = await receipt(w, l);
  seeded = { w, l, r }; beforeMigration = await snapshot(w);
  await admin.query(await readFile(new URL('../../supabase/migrations/20261105092311_linky_service_extension.sql', import.meta.url), 'utf8'));
  afterMigration = await snapshot(w);
});
after(async () => {
  // Keep the marked disposable schema/roles for the subsequent real browser stage.
  const results = await Promise.allSettled([runtime?.end(), operator?.end(), admin.end()]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
});

test('V2 preserves every pre-migration V1 row and final-use receipt semantics', async () => {
  assert.deepEqual(afterMigration, beforeMigration);
  const { w, l, r } = seeded;
  assert.equal((await call('owner_connect', w.hash, {})).workspace.id, w.id);
  assert.deepEqual(await call('owner_create_link', w.hash, l.payload), { workspaceId: w.id, linkId: l.linkId, revisionId: l.revisionId, version: 1, replayed: true });
  assert.equal((await call('recipient_redeem', r.recipientHash, { grantId: r.grantId, redemptionKey: r.key })).receiptId, r.receiptId);
  await denied(call('recipient_redeem', r.recipientHash, { grantId: r.grantId, redemptionKey: randomUUID() }), 'linky_exhausted');
});

test('V2 extends only reviewed function grants while ten tables remain private and RLS enabled', async () => {
  const rows = (await admin.query(`SELECT p.proname,p.proconfig,p.prosecdef,
    has_function_privilege('linky_runtime',p.oid,'EXECUTE') runtime,
    has_function_privilege('linky_operator',p.oid,'EXECUTE') operator,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='linky_private'`)).rows;
  assert.deepEqual(rows.filter(x => x.runtime).map(x => x.proname).sort(), [...functions].sort());
  assert.deepEqual(rows.filter(x => x.operator).map(x => x.proname).sort(), ['operator_provision','operator_recover_owner']);
  for (const fn of rows) { assert.equal(fn.public, false); assert.ok(fn.proconfig.includes('search_path=""')); if (fn.runtime || fn.operator) assert.equal(fn.prosecdef, true); }
  const tables = (await admin.query(`SELECT c.relname,c.relrowsecurity,pg_get_userbyid(c.relowner) owner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='linky_private' AND c.relkind='r'`)).rows;
  assert.equal(tables.length, 10); for (const t of tables) { assert.equal(t.relrowsecurity, true); assert.equal(t.owner, 'linky_function_owner'); }
  for (const pool of [runtime, operator]) for (const table of ['conversion_credentials','conversion_events']) await assert.rejects(pool.query(`SELECT * FROM linky_private.${table}`), e => e.code === '42501');
  await assert.rejects(runtime.query(`SELECT linky_private._conversion_credential(repeat('a',64),'${randomUUID()}'::uuid)`), e => e.code === '42501');
});

test('credential issue uses link CAS and a durable exact acknowledgement without key disclosure', async () => {
  const w = await workspace(), l = await link(w), c = await credential(w, l);
  assert.deepEqual(Object.keys(c).filter(x => !['hash','payload'].includes(x)).sort(), ['workspaceId','linkId','credentialId','revisionId','version','replayed'].sort());
  assert.equal(c.version, 2); assert.equal(c.replayed, false);
  assert.deepEqual(await call('owner_issue_conversion_credential', w.hash, c.payload), { workspaceId: w.id, linkId: l.linkId, credentialId: c.credentialId, revisionId: l.revisionId, version: 2, replayed: true });
  const list = await call('owner_list_conversion_credentials', w.hash, { workspaceId: w.id, linkId: l.linkId, limit: 1, after: null });
  assert.equal(list.credentials.length, 1); assert.equal(list.credentials[0].purpose, 'conversion_ingest'); assert.equal(list.nextCursor, c.credentialId);
  assert.deepEqual(Object.keys(list.credentials[0]).sort(), ['id','linkId','revisionId','label','purpose','expiresAt','revokedAt','createdAt'].sort());
  assert.ok(!JSON.stringify(list).includes(c.hash));
  assert.deepEqual((await call('owner_list_conversion_credentials', w.hash, { workspaceId: w.id, linkId: l.linkId, after: c.credentialId })).credentials, []);
});

test('concurrent credential issuance admits one CAS winner and one conflict', async () => {
  const w = await workspace(), l = await link(w);
  const outcomes = await Promise.allSettled([credential(w, l), credential(w, l)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1); assert.equal(outcomes.find(x => x.status === 'rejected').reason.message, 'linky_conflict');
  assert.equal((await admin.query('SELECT count(*)::int n FROM linky_private.conversion_credentials WHERE workspace_id=$1', [w.id])).rows[0].n, 1);
});

test('lead declarations inherit receipt campaign and never return a usable destination or credential', async () => {
  const { w, l, r, c } = await cohort(), input = event(c, r), ack = await ingest(c, input);
  assert.deepEqual(Object.keys(ack).sort(), ['eventId','workspaceId','linkId','revisionId','receiptId','eventKey','kind','acceptedAt','replayed'].sort());
  assert.equal(ack.receiptId, r.receiptId); assert.equal(ack.kind, 'lead_declared'); assert.equal(ack.replayed, false);
  const stored = (await admin.query('SELECT campaign_snapshot,credential_id,declared_at,accepted_at FROM linky_private.conversion_events WHERE id=$1', [ack.eventId])).rows[0];
  assert.deepEqual(stored.campaign_snapshot, campaign); assert.equal(stored.credential_id, c.credentialId); assert.ok(stored.accepted_at > stored.declared_at);
  const view = await report(w); assert.equal(view.redemptions.count, 1); assert.equal(view.declarations.leads, 1); assert.equal(view.declarations.total, 1);
  assert.equal(JSON.stringify(ack).includes(l.payload.destination), false); assert.equal(JSON.stringify(ack).includes(c.hash), false);
});

test('concurrent same events through independent credentials commit one immutable accepting identity', async () => {
  const { w, l, r, c } = await cohort(), second = await credential(w, { ...l, version: c.version });
  const input = event(c, r), outcomes = await Promise.all([ingest(c, input), ingest(second, { ...input, credentialId: second.credentialId })]);
  assert.equal(outcomes[0].eventId, outcomes[1].eventId); assert.deepEqual(outcomes.map(x => x.replayed).sort(), [false, true]);
  const stored = (await admin.query('SELECT credential_id FROM linky_private.conversion_events WHERE id=$1', [outcomes[0].eventId])).rows[0];
  assert.equal(stored.credential_id, outcomes[0].replayed ? second.credentialId : c.credentialId);
  assert.deepEqual(await conversionCounts(w), { events: 1, audits: 1 });
});

test('same workspace event keys reject changed declaration semantics and receipt scope', async () => {
  const { w, l, r, c } = await cohort(), input = event(c, r); await ingest(c, input);
  for (const override of [{ kind: 'sale_declared' }, { declaredAt: '2021-01-01T00:00:00.000Z' }, { kind: 'sale_declared', amountMinor: 10, currency: 'USD' }]) await denied(ingest(c, { ...input, ...override }), 'linky_conflict');
  const otherLink = await link(w), otherReceipt = await receipt(w, otherLink), otherCredential = await credential(w, { ...otherLink, version: otherReceipt.linkVersion });
  await denied(ingest(otherCredential, { ...input, credentialId: otherCredential.credentialId, receiptId: otherReceipt.receiptId }), 'linky_conflict');
  assert.deepEqual(await conversionCounts(w), { events: 1, audits: 1 });
});

test('rotation can recover an event through a valid replacement while revoked credentials cannot replay', async () => {
  const { w, l, r, c } = await cohort(), input = event(c, r), original = await ingest(c, input);
  const replacement = await credential(w, { ...l, version: c.version });
  const revoke = { workspaceId: w.id, mutationKey: randomUUID(), linkId: l.linkId, credentialId: c.credentialId, expectedVersion: replacement.version };
  const ack = await call('owner_revoke_conversion_credential', w.hash, revoke);
  assert.equal(ack.version, replacement.version + 1); assert.deepEqual(await call('owner_revoke_conversion_credential', w.hash, revoke), { ...ack, replayed: true });
  await denied(ingest(c, input), 'linky_revoked');
  const replay = await ingest(replacement, { ...input, credentialId: replacement.credentialId }); assert.deepEqual(replay, { ...original, replayed: true });
  assert.equal((await admin.query('SELECT credential_id FROM linky_private.conversion_events WHERE id=$1', [original.eventId])).rows[0].credential_id, c.credentialId);
});

test('credential expiry after a verified link lock wait denies even an old event acknowledgement', async () => {
  const w = await workspace(), l = await link(w), r = await receipt(w, l), c = await credential(w, { ...l, version: r.linkVersion }, { expiresAt: new Date(Date.now() + 2000).toISOString() });
  const input = event(c, r); await ingest(c, input);
  const holder = await admin.connect(), waiter = await runtime.connect(); let pending;
  try {
    const pid = (await waiter.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('BEGIN'); await holder.query('SELECT id FROM linky_private.links WHERE id=$1 FOR UPDATE', [l.linkId]);
    pending = ingest(c, input, waiter).then(value => ({ value }), error => ({ error }));
    const end = Date.now() + 3000; let blocked = false;
    while (Date.now() < end) { blocked = (await admin.query("SELECT wait_event_type='Lock' blocked FROM pg_catalog.pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.blocked; if (blocked) break; await delay(25); }
    assert.equal(blocked, true);
    await holder.query('SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.05)', [c.payload.expiresAt]); await holder.query('COMMIT');
    assert.equal((await pending).error?.message, 'linky_expired'); assert.deepEqual(await conversionCounts(w), { events: 1, audits: 1 });
  } finally { await holder.query('ROLLBACK'); if (pending) await pending; holder.release(); waiter.release(); }
});

test('inactive links and closed workspaces deny current declaration receipt replays', async () => {
  const { w, l, r, c } = await cohort(), input = event(c, r); await ingest(c, input); let version = c.version;
  for (const state of ['paused', 'blocked', 'active']) {
    const ack = await call('owner_set_link_state', w.hash, { workspaceId: w.id, mutationKey: randomUUID(), linkId: l.linkId, expectedVersion: version, state }); version = ack.version;
    if (state !== 'active') await denied(ingest(c, input), 'linky_inactive');
  }
  assert.equal((await ingest(c, input)).replayed, true);
  await call('owner_close', w.hash, { workspaceId: w.id, mutationKey: randomUUID(), expectedOwnerKeyVersion: 1 }); await denied(ingest(c, input), 'linky_closed');
});

test('ingest capabilities cannot authorize owner or recipient operations and the reverse substitution fails', async () => {
  const { w, r, c } = await cohort(), input = event(c, r);
  await denied(call('owner_connect', c.hash, {}), 'linky_denied');
  await denied(call('recipient_inspect', c.hash, { grantId: r.grantId }), 'linky_denied');
  await denied(call('conversion_ingest', w.hash, input), 'linky_denied'); await denied(call('conversion_ingest', r.recipientHash, input), 'linky_denied');
});

test('conversion credential scope cannot cross workspace link revision or composite foreign keys', async () => {
  const a = await cohort(), b = await cohort();
  await denied(ingest(a.c, event(a.c, b.r)), 'linky_scope');
  await denied(credential(a.w, { ...a.l, version: a.c.version }, { revisionId: b.l.revisionId }), 'linky_scope');
  await denied(call('owner_list_conversion_credentials', b.w.hash, { workspaceId: a.w.id, linkId: a.l.linkId }), 'linky_denied');
  await assert.rejects(admin.query(`INSERT INTO linky_private.conversion_events VALUES($1,$2,$3,$4,$5,$6,$7,'lead_declared',NULL,NULL,clock_timestamp(),clock_timestamp(),repeat('a',64),$8::jsonb)`,
    [randomUUID(), a.w.id, a.l.linkId, a.l.revisionId, a.r.receiptId, b.c.credentialId, randomUUID(), JSON.stringify(campaign)]), e => e.code === '23503');
});

test('an expired recipient grant does not revoke a separately current conversion credential', async () => {
  const w = await workspace(), l = await link(w), r = await receipt(w, l, new Date(Date.now() + 1000).toISOString()), c = await credential(w, { ...l, version: r.linkVersion });
  await admin.query('SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.05)', [r.expiresAt]);
  await denied(call('recipient_redeem', r.recipientHash, { grantId: r.grantId, redemptionKey: r.key }), 'linky_expired');
  assert.equal((await ingest(c, event(c, r))).replayed, false);
});

test('declaration shapes enforce unknown versus zero values exact integer bounds and currency', async () => {
  const { w, r, c } = await cohort();
  for (const override of [{ amountMinor: 1 }, { currency: 'USD' }, { kind: 'sale_declared', amountMinor: -1, currency: 'USD' },
    { kind: 'sale_declared', amountMinor: 1.5, currency: 'USD' }, { kind: 'sale_declared', amountMinor: 9007199254740992, currency: 'USD' },
    { kind: 'sale_declared', amountMinor: 1, currency: 'usd' }, { kind: 'sale_declared', amountMinor: 1, currency: null }, { kind: 'purchase' }, { extra: 'unknown' }]) {
    await denied(ingest(c, event(c, r, override)), 'linky_invalid');
  }
  await ingest(c, event(c, r, { kind: 'sale_declared' })); await ingest(c, event(c, r, { kind: 'sale_declared', amountMinor: 0, currency: 'USD' }));
  const result = await report(w); assert.equal(result.declarations.sales, 2); assert.equal(result.declarations.unknownValueSales, 1);
  assert.deepEqual(result.declarations.currencies, [{ currency: 'USD', amountMinor: '0', sales: 1 }]);
});

test('reports preserve exact sums beyond safe integers without combining currencies or unknown sales', async () => {
  const { w, r, c } = await cohort();
  for (const [amountMinor, currency] of [[9007199254740991,'USD'],[9007199254740991,'USD'],[25,'EUR'],[null,null]]) await ingest(c, event(c, r, { kind: 'sale_declared', amountMinor, currency }));
  await ingest(c, event(c, r));
  const result = await report(w);
  assert.equal(result.declarations.total, 5); assert.equal(result.declarations.leads, 1); assert.equal(result.declarations.sales, 4); assert.equal(result.declarations.unknownValueSales, 1);
  assert.deepEqual(result.declarations.currencies, [{ currency: 'EUR', amountMinor: '25', sales: 1 }, { currency: 'USD', amountMinor: '18014398509481982', sales: 2 }]);
  assert.deepEqual(result.declarations.campaigns, [{ campaign, leads: 1, sales: 4, unknownValueSales: 1 }]);
});

test('report coverage independently bounds committed redemptions and accepted declarations', async () => {
  const { w, r, c } = await cohort(); await ingest(c, event(c, r)); await ingest(c, event(c, r));
  const view = await report(w, { limit: 1 });
  assert.equal(view.redemptions.count, 1); assert.equal(view.redemptions.coverage.truncated, false);
  assert.equal(view.declarations.total, 1); assert.equal(view.declarations.coverage.truncated, true);
  assert.equal(view.redemptions.coverage.kind, 'committed_redemptions'); assert.equal(view.declarations.coverage.kind, 'accepted_conversion_declarations');
  assert.equal(view.redemptions.coverage.recordCount, 1); assert.equal(view.declarations.coverage.recordCount, 1);
  const oldWindow = await report(w, { from: '2019-12-01T00:00:00.000Z', to: '2020-02-01T00:00:00.000Z' });
  assert.equal(oldWindow.declarations.total, 0); // declaredAt falls here, acceptedAt does not.
});

test('conversion audit failure rolls back the event and same-key retry commits once', async () => {
  const { w, r, c } = await cohort(), input = event(c, r);
  await admin.query(`CREATE FUNCTION linky_private.authored_v2_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${w.id}'::uuid AND NEW.action='conversion_ingest' THEN RAISE EXCEPTION 'authored_v2_audit_fault'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER authored_v2_fault BEFORE INSERT ON linky_private.audit_events FOR EACH ROW EXECUTE FUNCTION linky_private.authored_v2_fault()`);
  try { await assert.rejects(ingest(c, input), e => e.message === 'authored_v2_audit_fault'); assert.deepEqual(await conversionCounts(w), { events: 0, audits: 0 }); }
  finally { await admin.query('DROP TRIGGER authored_v2_fault ON linky_private.audit_events; DROP FUNCTION linky_private.authored_v2_fault()'); }
  assert.equal((await ingest(c, input)).replayed, false); assert.deepEqual(await conversionCounts(w), { events: 1, audits: 1 });
});

test('fifty-row bulk creates retain per-row identities and replay without duplicate writes', async () => {
  const w = await workspace();
  const hostname = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(53), 'org'].join('.');
  const rows = Array.from({ length: 50 }, (_, i) => row(i, { destination: `https://${hostname}/`, safety: { ...safety, hostname } }));
  const wire = { workspaceId: w.id, rows: rows.map(({ mutationKey, linkId, revisionId, slug, label, destination, campaign }) => ({ mutationKey, linkId, revisionId, slug,
    draft: { title: label, destination, source: campaign.source, medium: campaign.medium, campaign: campaign.campaign } })) };
  assert.ok(Buffer.byteLength(JSON.stringify(wire)) <= 32768, 'actual unexpanded HTTP DTO fits its unchanged wire limit');
  assert.ok((await admin.query('SELECT pg_column_size($1::jsonb) bytes', [JSON.stringify({ workspaceId: w.id, rows })])).rows[0].bytes > 32768,
    'normalized safety/hostname expansion exceeds the old whole-payload SQL bound');
  const result = await bulk(w, [...rows].reverse()); assert.equal(result.outcomes.length, 50);
  assert.deepEqual(result.outcomes.map(x => x.sourceIndex), rows.map(x => x.sourceIndex));
  for (const outcome of result.outcomes) { assert.equal(outcome.status, 'committed'); assert.equal(outcome.version, 1); assert.equal(outcome.error, null); assert.equal(outcome.linkId, rows[outcome.sourceIndex].linkId); assert.equal(outcome.mutationKey, rows[outcome.sourceIndex].mutationKey); }
  const retry = await bulk(w, rows); assert.ok(retry.outcomes.every(x => x.status === 'replayed' && x.version === 1 && x.error === null));
  assert.equal((await admin.query('SELECT count(*)::int n FROM linky_private.links WHERE workspace_id=$1', [w.id])).rows[0].n, 50);
});

test('mixed bulk errors roll back each failed row while independent rows commit and replay', async () => {
  const w = await workspace(), existing = await link(w), rows = [row(4), row(1, { slug: existing.payload.slug }), row(7, { destination: 'https://127.0.0.1/' })];
  const result = await bulk(w, rows); assert.deepEqual(result.outcomes.map(x => [x.sourceIndex,x.status,x.error]), [[1,'error','linky_conflict'],[4,'committed',null],[7,'error','linky_invalid']]);
  const retry = await bulk(w, rows); assert.equal(retry.outcomes.find(x => x.sourceIndex === 4).status, 'replayed');
  const stored = (await admin.query('SELECT id FROM linky_private.links WHERE workspace_id=$1', [w.id])).rows.map(x => x.id);
  assert.deepEqual(new Set(stored), new Set([existing.linkId, rows[0].linkId]));
});

test('duplicate batch identities and excessive rows refuse before any row commits', async () => {
  const w = await workspace();
  for (const field of ['sourceIndex','mutationKey','linkId','revisionId','slug']) {
    const a = row(0), b = row(1); b[field] = a[field]; await denied(bulk(w, [a,b]), 'linky_conflict');
  }
  await denied(bulk(w, []), 'linky_invalid'); await denied(bulk(w, Array.from({ length: 51 }, (_, i) => row(i))), 'linky_invalid');
  assert.equal((await admin.query('SELECT count(*)::int n FROM linky_private.links WHERE workspace_id=$1', [w.id])).rows[0].n, 0);
});

test('overlapping reverse-order concurrent batches serialize stable keys without duplicate rows', async () => {
  const w = await workspace(), rows = [row(0),row(1),row(2)];
  const results = await Promise.all([bulk(w, rows), bulk(w, [...rows].reverse())]);
  assert.deepEqual(results.map(x => x.outcomes[0].status).sort(), ['committed','replayed']);
  assert.equal((await admin.query('SELECT count(*)::int n FROM linky_private.links WHERE workspace_id=$1', [w.id])).rows[0].n, 3);
  assert.equal((await admin.query("SELECT count(*)::int n FROM linky_private.mutation_receipts WHERE workspace_id=$1 AND operation='create_link'", [w.id])).rows[0].n, 3);
});

test('owner rotation and raw ingest-shaped content stay fenced for bulk and credential mutations', async () => {
  const w = await workspace(), rows = [row(0)]; await bulk(w, rows);
  const next = capability('lyo'); await call('owner_rotate', w.hash, { workspaceId: w.id, mutationKey: randomUUID(), newOwnerHash: next, expectedOwnerKeyVersion: 1 });
  await denied(bulk(w, rows), 'linky_denied'); const current = { ...w, hash: next }; assert.equal((await bulk(current, rows)).outcomes[0].status, 'replayed');
  const blocked = await bulk(current, [row(1, { label: `lyi_${'a'.repeat(64)}` })]); assert.equal(blocked.outcomes[0].error, 'linky_invalid');
  const l = await link(current); await denied(credential(current, l, { label: `lyi_${'b'.repeat(64)}` }), 'linky_invalid');
});

test('conversion event history and credential scope remain immutable after acceptance', async () => {
  const { w, r, c } = await cohort(), ack = await ingest(c, event(c, r));
  await denied(admin.query('UPDATE linky_private.conversion_events SET amount_minor=1 WHERE id=$1', [ack.eventId]), 'linky_immutable');
  await denied(admin.query('DELETE FROM linky_private.conversion_events WHERE id=$1', [ack.eventId]), 'linky_immutable');
  await denied(admin.query('UPDATE linky_private.conversion_credentials SET revision_id=$1 WHERE id=$2', [randomUUID(), c.credentialId]), 'linky_immutable');
  await denied(admin.query('DELETE FROM linky_private.conversion_credentials WHERE id=$1', [c.credentialId]), 'linky_immutable');
  assert.deepEqual(await conversionCounts(w), { events: 1, audits: 1 });
});
