import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pools, denied, functions } from '../fixtures/origin-db.mjs';
import { generateCapability, hashCapability } from '../../server/capabilities.mjs';
import { createHandler } from '../../server/http.mjs';
import { createPostgresRepository } from '../../server/postgres.mjs';
import { runtimeUrl } from '../fixtures/origin-db.mjs';

let db, preserved, beforeRows, afterRows, priorFunctions;
const hash = value => createHash('sha256').update(value).digest('hex');
async function snapshot(w) {
  const result = {};
  for (const table of ['workspaces','links','destination_revisions','grants','redemption_receipts','attribution_events','mutation_receipts','audit_events','conversion_credentials','conversion_events']) result[table] = (await db.admin.query(`SELECT to_jsonb(x) value FROM linky_private.${table} x WHERE ${table === 'workspaces' ? 'id' : 'workspace_id'}=$1 ORDER BY id`, [w.id])).rows.map(row => row.value);
  return result;
}
before(async () => {
  db = await pools();
  assert.equal((await db.admin.query("SELECT to_regnamespace('linky_private') namespace")).rows[0].namespace, null);
  await db.admin.query(await readFile(new URL('../../db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const [name, digest] of [['20261105080045_linky_initial_service.sql','406957876504aeb4c99a42f6488f24c325aaf9c2e41b8dc501f5c227b08249be'],['20261105092311_linky_service_extension.sql','e8153d0486e7c997d4e85ca18b2b4a2ab9822908125c1cad44c5697b8738a092']]) {
    const bytes = await readFile(new URL('../../supabase/migrations/' + name, import.meta.url)); assert.equal(hash(bytes), digest); await db.admin.query(bytes.toString('utf8'));
  }
  await db.admin.query("ALTER ROLE linky_runtime PASSWORD 'authored-origin-runtime'; ALTER ROLE linky_operator PASSWORD 'authored-origin-operator'");
  const w = await db.workspace(), l = await db.link(w), r = await db.receipt(w, l);
  const ingestKey = generateCapability('ingest'), ingestHash = hashCapability(ingestKey, 'ingest'), credentialId = randomUUID();
  await db.call('owner_issue_conversion_credential', w.hash, { workspaceId: w.id, mutationKey: randomUUID(), linkId: l.linkId, revisionId: l.revisionId, expectedVersion: r.linkVersion, credentialId, ingestHash, label: 'Preserved V2 declarations', expiresAt: new Date(Date.now() + 120000).toISOString() });
  await db.call('conversion_ingest', ingestHash, { credentialId, receiptId: r.receiptId, eventKey: randomUUID(), kind: 'sale_declared', amountMinor: 1500, currency: 'EUR', declaredAt: '2020-01-01T00:00:00.000Z' });
  preserved = { w, l, r }; beforeRows = await snapshot(w);
  priorFunctions = (await db.admin.query("SELECT p.proname,pg_get_functiondef(p.oid) definition,p.proacl::text acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='linky_private' AND p.proname<>'_text' ORDER BY p.proname")).rows;
  const migration = await readFile(process.env.LINKY_V3_MIGRATION); assert.deepEqual(migration, await readFile(new URL('../../docs/proposals/protected-resources.sql', import.meta.url)));
  await db.admin.query(migration.toString('utf8')); afterRows = await snapshot(w);
});
after(async () => { await db?.close(); });

test('D01 additive migration preserves all authored V1/V2 rows byte for byte', () => assert.deepEqual(afterRows, beforeRows));
test('D02 existing functions and ACLs stay identical except the explicit secret text guard', async () => {
  const current = (await db.admin.query("SELECT p.proname,pg_get_functiondef(p.oid) definition,p.proacl::text acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='linky_private' AND p.proname=ANY($1::text[]) ORDER BY p.proname", [priorFunctions.map(row => row.proname)])).rows;
  assert.deepEqual(current, priorFunctions);
});
test('D03 new tables have RLS and no runtime/operator/public table grants', async () => {
  const rows = (await db.admin.query("SELECT c.relname,c.relrowsecurity,has_table_privilege('linky_runtime',c.oid,'SELECT,INSERT,UPDATE,DELETE') runtime,has_table_privilege('linky_operator',c.oid,'SELECT,INSERT,UPDATE,DELETE') operator FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='linky_private' AND c.relname IN ('origin_credentials','resource_access') ORDER BY c.relname")).rows;
  assert.equal(rows.length, 2); for (const row of rows) { assert(row.relrowsecurity); assert.equal(row.runtime, false); assert.equal(row.operator, false); }
  await assert.rejects(() => db.runtime.query('SELECT * FROM linky_private.resource_access'), error => error.code === '42501');
});
test('D04 only six new definer functions are executable by runtime; helpers stay private', async () => {
  const newNames = [...functions].slice(-6);
  const rows = (await db.admin.query("SELECT p.proname,p.prosecdef,p.proconfig,has_function_privilege('linky_runtime',p.oid,'EXECUTE') runtime,has_function_privilege('linky_operator',p.oid,'EXECUTE') operator FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='linky_private' AND (p.proname=ANY($1::text[]) OR p.proname IN ('_resource_receipt','_resource_target','_resource_access_change','_origin_credential_change'))", [newNames])).rows;
  assert.equal(rows.length, 10); for (const row of rows) { assert.equal(row.runtime, newNames.includes(row.proname)); assert.equal(row.operator, false); if (row.runtime) assert(row.prosecdef); assert(row.proconfig.some(value => value.startsWith('search_path='))); }
});
test('D05 owner issue derives the resource URL and replays only identical intent', async () => {
  const w = await db.workspace(), l = await db.link(w), c = await db.credential(w, l);
  assert.equal(c.resourceUrl, l.payload.destination);
  const replay = await db.call('owner_issue_origin_credential', w.hash, c.payload); assert.equal(replay.replayed, true); assert.equal(replay.version, c.version);
  await denied(() => db.call('owner_issue_origin_credential', w.hash, { ...c.payload, label: 'Changed' }), 'linky_conflict');
});
test('D06 owner list is scoped, bounded and never returns hashes or raw keys', async () => {
  const { w, l, c } = await db.cohort();
  const value = await db.call('owner_list_origin_credentials', w.hash, { workspaceId: w.id, linkId: l.linkId, limit: 1, after: null });
  assert.equal(value.credentials.length, 1); assert.equal(value.credentials[0].purpose, 'resource_authorize'); assert.equal(value.credentials[0].id, c.credentialId); assert(!/hash|lyp_/u.test(JSON.stringify(value)));
  const other = await db.workspace(); await denied(() => db.call('owner_list_origin_credentials', other.hash, { workspaceId: w.id, linkId: l.linkId }), 'linky_denied');
});
test('D07 issuing host credentials rejects stale versions and non-HTTPS/fragment revisions', async () => {
  const w = await db.workspace(), l = await db.link(w); await db.credential(w, l);
  await denied(() => db.credential(w, l), 'linky_conflict');
  for (const target of ['http://resource.example.com/private.bin','https://resource.example.com/private.bin#part']) {
    const row = await db.link(w, target); await denied(() => db.credential(w, row), 'linky_resource_unavailable');
  }
});
test('D08 resource inspection needs an authorized committed receipt and an active integration', async () => {
  const w = await db.workspace(), l = await db.link(w), r = await db.receipt(w, l);
  await denied(() => db.call('recipient_resource_inspect', r.hash, { grantId: r.grantId, receiptId: r.receiptId }), 'linky_resource_unavailable');
  await db.credential(w, { ...l, version: r.linkVersion });
  const value = await db.call('recipient_resource_inspect', r.hash, { grantId: r.grantId, receiptId: r.receiptId }); assert.equal(value.accessVersion, 0);
  await denied(() => db.call('recipient_resource_inspect', r.hash, { grantId: r.grantId, receiptId: randomUUID() }), 'linky_denied');
});
test('D09 preparation is content-bound, idempotent and does not consume another use', async () => {
  const { r, a } = await db.cohort();
  const replay = await db.call('recipient_prepare_resource_access', r.hash, a.payload); assert.equal(replay.replayed, true); assert.equal(replay.accessId, a.accessId);
  await denied(() => db.call('recipient_prepare_resource_access', r.hash, { ...a.payload, expectedAccessVersion: 1 }), 'linky_conflict');
  const counts = (await db.admin.query('SELECT used_count,(SELECT count(*)::int FROM linky_private.redemption_receipts WHERE grant_id=$1) receipts FROM linky_private.grants WHERE id=$1', [r.grantId])).rows[0]; assert.deepEqual(counts, { used_count: 1, receipts: 1 });
});
test('D10 rotation invalidates the previous key and stale intents cannot resurrect it', async () => {
  const { r, c, a } = await db.cohort(); const replacement = await db.prepare(r, 1); assert.equal(replacement.version, 2);
  await denied(() => db.authorize(c, a), 'linky_denied'); assert.equal((await db.authorize(c, replacement)).authorized, true);
  await denied(() => db.call('recipient_prepare_resource_access', r.hash, a.payload), 'linky_conflict');
});
test('D11 concurrent replacements serialize and exactly one observed-version intent commits', async () => {
  const { r } = await db.cohort(); const outcomes = await Promise.allSettled([db.prepare(r, 1), db.prepare(r, 1)]);
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1); assert.equal(outcomes.find(row => row.status === 'rejected').reason.message, 'linky_conflict');
});
test('D12 access and host credentials cannot cross workspace/link/revision scopes', async () => {
  const first = await db.cohort(), second = await db.cohort();
  await denied(() => db.authorize(first.c, second.a), 'linky_denied');
  await denied(() => db.call('recipient_prepare_resource_access', first.r.hash, { ...first.a.payload, receiptId: second.r.receiptId }), 'linky_denied');
  await denied(() => db.authorize({ ...first.c, hash: second.c.hash }, first.a), 'linky_denied');
});
test('D13 repeated GET authorization is read-only and returns the earlier expiry', async () => {
  const { w, r, c, a } = await db.cohort({ credential: { expiresAt: new Date(Date.now() + 60000).toISOString() } }); const before = await snapshot(w);
  for (let index = 0; index < 3; index++) { const value = await db.authorize(c, a); assert.equal(value.authorized, true); assert.equal(Date.parse(value.expiresAt), Date.parse(c.payload.expiresAt)); }
  assert.deepEqual(await snapshot(w), before); assert.equal((await db.call('recipient_inspect', r.hash, { grantId: r.grantId })).remainingUses, 0);
});
test('D14 committed grant revocation denies learned access and preparation replays', async () => {
  const { w, l, r, c, a } = await db.cohort();
  await db.call('owner_revoke_grant', w.hash, { workspaceId: w.id, linkId: l.linkId, grantId: r.grantId, mutationKey: randomUUID(), expectedVersion: c.version });
  await denied(() => db.authorize(c, a), 'linky_revoked'); await denied(() => db.call('recipient_prepare_resource_access', r.hash, a.payload), 'linky_revoked');
});
test('D15 committed host revocation denies current access and is idempotent', async () => {
  const { w, l, c, a } = await db.cohort(); const payload = { workspaceId: w.id, linkId: l.linkId, credentialId: c.credentialId, mutationKey: randomUUID(), expectedVersion: c.version };
  const ack = await db.call('owner_revoke_origin_credential', w.hash, payload); assert.equal(ack.replayed, false); assert.equal((await db.call('owner_revoke_origin_credential', w.hash, payload)).replayed, true);
  await denied(() => db.authorize(c, a), 'linky_origin_revoked');
});
test('D16 pause and workspace closure stop origin authorization', async () => {
  const { w, l, c, a } = await db.cohort();
  await db.call('owner_set_link_state', w.hash, { workspaceId: w.id, linkId: l.linkId, mutationKey: randomUUID(), expectedVersion: c.version, state: 'paused' }); await denied(() => db.authorize(c, a), 'linky_inactive');
  const other = await db.cohort(); await db.call('owner_close', other.w.hash, { workspaceId: other.w.id, mutationKey: randomUUID(), expectedOwnerKeyVersion: 1 }); await denied(() => db.authorize(other.c, other.a), 'linky_closed');
});
for (const scope of ['grant','origin']) test('D17 ' + scope + ' expiry is checked after a waiting final credential lock', async () => {
  const expiry = new Date(Date.now() + 1800).toISOString();
  const { c, a } = await db.cohort(scope === 'grant' ? { grantExpiry: expiry } : { credential: { expiresAt: expiry } });
  const blocker = await db.admin.connect(); let pending;
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM linky_private.origin_credentials WHERE id=$1 FOR UPDATE', [c.credentialId]);
    pending = db.authorize(c, a); pending.catch(() => {});
    const limit = Date.now() + 1000; let waiting = false;
    while (Date.now() < limit) { waiting = (await db.admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='linky-origin-disposable-v3' AND wait_event_type='Lock' AND query LIKE '%origin_authorize%') waiting")).rows[0].waiting; if (waiting) break; await delay(20); }
    assert(waiting); await delay(Math.max(0, Date.parse(expiry) - Date.now() + 100)); await blocker.query('COMMIT');
    await denied(() => pending, scope === 'grant' ? 'linky_expired' : 'linky_origin_expired');
  } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending.catch(() => {}); }
});
test('D18 scope and receipt identities cannot be changed or deleted', async () => {
  const { c, a } = await db.cohort();
  await denied(() => db.admin.query('UPDATE linky_private.resource_access SET receipt_id=$1 WHERE id=$2', [randomUUID(), a.accessId]), 'linky_immutable');
  await denied(() => db.admin.query('DELETE FROM linky_private.resource_access WHERE id=$1', [a.accessId]), 'linky_immutable');
  await denied(() => db.admin.query("UPDATE linky_private.origin_credentials SET resource_url='https://elsewhere.example.com/' WHERE id=$1", [c.credentialId]), 'linky_immutable');
});
test('D19 new raw capability shapes are refused by shared SQL text validation', async () => {
  const { w, l } = await db.cohort();
  for (const purpose of ['origin','access']) await denied(() => db.call('owner_list_links', w.hash, { workspaceId: w.id, search: generateCapability(purpose) }), 'linky_invalid');
  assert(l.linkId);
});
test('D20 real repository and HTTP commit access then enforce revoked key with safe errors', async () => {
  const { w, l, r, c, a } = await db.cohort(); const repository = await createPostgresRepository({ connectionString: runtimeUrl, allowInsecureLoopback: true });
  const origin = 'https://linky.example.com', handler = createHandler({ origin, repository });
  const send = () => handler(new Request(origin + '/api/v1/origin/authorize', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.key }, body: JSON.stringify({ credentialId: c.credentialId, accessId: a.accessId, accessKey: a.key }) }));
  try {
    assert.equal((await send()).status, 200);
    await db.call('owner_revoke_grant', w.hash, { workspaceId: w.id, linkId: l.linkId, grantId: r.grantId, mutationKey: randomUUID(), expectedVersion: c.version });
    const reply = await send(); assert.equal(reply.status, 410); assert.deepEqual(await reply.json(), { error: { code: 'grant_revoked' } });
  } finally { await repository.close(); }
});
test('D21 a prior authorized transaction finishes before revocation commits; later decisions fail', async () => {
  const { w, l, r, c, a } = await db.cohort(); const reader = await db.runtime.connect(); let mutation;
  try {
    await reader.query('BEGIN'); assert.equal((await db.authorize(c, a, reader)).authorized, true);
    mutation = db.call('owner_revoke_grant', w.hash, { workspaceId: w.id, linkId: l.linkId, grantId: r.grantId, mutationKey: randomUUID(), expectedVersion: c.version }); mutation.catch(() => {});
    const limit = Date.now() + 1000; let waiting = false;
    while (Date.now() < limit) { waiting = (await db.admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='linky-origin-disposable-v3' AND wait_event_type='Lock' AND query LIKE '%owner_revoke_grant%') waiting")).rows[0].waiting; if (waiting) break; await delay(20); }
    assert(waiting); await reader.query('COMMIT'); await mutation; await denied(() => db.authorize(c, a), 'linky_revoked');
  } finally { await reader.query('ROLLBACK'); reader.release(); if (mutation) await mutation.catch(() => {}); }
});
