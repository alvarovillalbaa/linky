import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// T3: real disposable PostgreSQL 17 only. These guards precede the driver import.
const expectedUrl = 'postgresql://postgres:authored-ci-only@127.0.0.1:5432/linky_checks';
if (process.env.CI !== 'true' || process.env.LINKY_DISPOSABLE_DB !== 'linky-pg17-ci-v1'
    || process.env.LINKY_DISPOSABLE_DATABASE !== 'true' || process.env.LINKY_TEST_DATABASE_URL !== expectedUrl) {
  throw new Error('linky_disposable_database_required');
}
const { default: pg } = await import('pg');
const poolOptions = { max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000,
  statement_timeout: 12000, lock_timeout: 8000, application_name: 'linky-disposable-checks' };
const admin = new pg.Pool({ ...poolOptions, connectionString: expectedUrl });
let runtime, operator;
const runtimeFunctions = new Set(['owner_connect', 'owner_rotate', 'owner_close', 'owner_create_link',
  'owner_revise_link', 'owner_set_link_state', 'owner_issue_grant', 'owner_revoke_grant',
  'owner_list_links', 'owner_list_grants', 'recipient_inspect', 'recipient_redeem', 'owner_report']);
async function call(name, hash, payload, client = runtime) {
  assert.ok(runtimeFunctions.has(name), 'source-owned SQL function allowlist');
  return (await client.query(`SELECT linky_private.${name}($1::text,$2::jsonb) AS result`, [hash, JSON.stringify(payload)])).rows[0].result;
}
async function operate(name, payload, operatorId = randomUUID()) {
  assert.ok(['operator_provision', 'operator_recover_owner'].includes(name));
  return (await operator.query(`SELECT linky_private.${name}($1::uuid,$2::jsonb) AS result`, [operatorId, JSON.stringify(payload)])).rows[0].result;
}
const hash = value => createHash('sha256').update(value).digest('hex');
const capability = purpose => hash(`${purpose}_${randomUUID()}_${randomUUID()}`);
const safe = hostname => ({ policyVersion: 'linky-address-v1', hostname, result: 'accepted', reputation: 'unchecked' });
const campaign = { source: 'authored', medium: 'disposable-ci', campaign: 'initial' };
async function workspace() {
  const w = { id: randomUUID(), hash: capability('lyo'), operatorId: randomUUID() };
  w.provision = { workspaceId: w.id, mutationKey: randomUUID(), name: 'Authored disposable workspace', ownerHash: w.hash };
  w.ack = await operate('operator_provision', w.provision, w.operatorId);
  return w;
}
async function link(w, overrides = {}) {
  const payload = { workspaceId: w.id, mutationKey: randomUUID(), linkId: randomUUID(), revisionId: randomUUID(),
    slug: `fixture_${randomUUID()}`, label: 'Authored link', destination: 'https://www.iana.org/domains/reserved',
    campaign: { ...campaign }, safety: safe('www.iana.org'), ...overrides };
  const ack = await call('owner_create_link', w.hash, payload);
  return { ...ack, payload };
}
async function grant(w, l, overrides = {}) {
  const recipientHash = capability('lyr');
  const payload = { workspaceId: w.id, mutationKey: randomUUID(), linkId: l.linkId, revisionId: l.revisionId,
    expectedVersion: l.version, grantId: randomUUID(), recipientHash, label: 'Authored recipient', maxUses: 1,
    expiresAt: new Date(Date.now() + 60000).toISOString(), ...overrides };
  const ack = await call('owner_issue_grant', w.hash, payload);
  return { ...ack, payload, hash: recipientHash };
}
const redeem = (g, redemptionKey = randomUUID(), client) => call('recipient_redeem', g.hash, { grantId: g.grantId, redemptionKey }, client);
const denied = (work, code) => assert.rejects(work, error => error.code === 'P0001' && error.message === code);
async function counters(g) {
  return (await admin.query(`SELECT g.used_count,
    (SELECT count(*)::int FROM linky_private.redemption_receipts r WHERE r.grant_id=g.id) receipts,
    (SELECT count(*)::int FROM linky_private.attribution_events e WHERE e.workspace_id=g.workspace_id AND e.link_id=g.link_id) events,
    (SELECT count(*)::int FROM linky_private.audit_events a WHERE a.actor_kind='recipient' AND a.actor_id=g.id) audits
    FROM linky_private.grants g WHERE g.id=$1::uuid`, [g.grantId])).rows[0];
}

before(async () => {
  const target = (await admin.query(`SELECT current_database() name, current_setting('server_version_num')::int version,
    shobj_description(oid,'pg_database') marker FROM pg_catalog.pg_database WHERE datname=current_database()`)).rows[0];
  assert.deepEqual({ name: target.name, major: Math.floor(target.version / 10000), marker: target.marker },
    { name: 'linky_checks', major: 17, marker: 'linky-disposable-ci-v1' });
  await admin.query(await readFile(new URL('../../db/bootstrap.sql', import.meta.url), 'utf8'));
  await admin.query(await readFile(new URL('../../supabase/migrations/20261105080045_linky_initial_service.sql', import.meta.url), 'utf8'));
  // Authored fixture credentials exist only inside this exact disposable cluster.
  await admin.query("ALTER ROLE linky_runtime PASSWORD 'authored-runtime-only'; ALTER ROLE linky_operator PASSWORD 'authored-operator-only'");
  runtime = new pg.Pool({ ...poolOptions, connectionString: 'postgresql://linky_runtime:authored-runtime-only@127.0.0.1:5432/linky_checks' });
  operator = new pg.Pool({ ...poolOptions, max: 2, connectionString: 'postgresql://linky_operator:authored-operator-only@127.0.0.1:5432/linky_checks' });
});
after(async () => {
  // Retain the owned schema and roles for the subsequent real HTTP/browser stage.
  const outcomes = await Promise.allSettled([runtime?.end(), operator?.end(), admin.end()]);
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
});

test('operator provision replays one committed workspace and rejects changed intent', async () => {
  const w = await workspace();
  assert.deepEqual(w.ack, { workspaceId: w.id, state: 'active', ownerKeyVersion: 1, replayed: false });
  assert.deepEqual(await operate('operator_provision', w.provision, w.operatorId), { ...w.ack, replayed: true });
  await denied(operate('operator_provision', { ...w.provision, name: 'Changed intent' }, w.operatorId), 'linky_conflict');
  const result = await call('owner_connect', w.hash, {});
  assert.deepEqual(result, { workspace: { id: w.id, name: w.provision.name, state: 'active', ownerKeyVersion: 1 } });
  assert.equal((await admin.query('SELECT count(*)::int n FROM linky_private.audit_events WHERE workspace_id=$1', [w.id])).rows[0].n, 1);
});

test('runtime and operator have only their explicit function capabilities and no data grants', async () => {
  const roles = (await admin.query(`SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls
    FROM pg_catalog.pg_roles WHERE rolname IN ('linky_function_owner','linky_runtime','linky_operator') ORDER BY rolname`)).rows;
  assert.equal(roles.length, 3);
  for (const row of roles) {
    assert.equal(row.rolcanlogin, row.rolname !== 'linky_function_owner');
    for (const flag of ['rolsuper','rolcreatedb','rolcreaterole','rolinherit','rolreplication','rolbypassrls']) assert.equal(row[flag], false);
  }
  assert.equal((await admin.query(`SELECT count(*)::int n FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member WHERE r.rolname IN ('linky_runtime','linky_operator')`)).rows[0].n, 0);
  const functions = (await admin.query(`SELECT p.proname,p.prosecdef,p.proconfig,
    has_function_privilege('linky_runtime',p.oid,'EXECUTE') runtime,
    has_function_privilege('linky_operator',p.oid,'EXECUTE') operator,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='linky_private'`)).rows;
  assert.deepEqual(functions.filter(row => row.runtime).map(row => row.proname).sort(), [...runtimeFunctions].sort());
  assert.deepEqual(functions.filter(row => row.operator).map(row => row.proname).sort(), ['operator_provision','operator_recover_owner']);
  for (const fn of functions) { assert.equal(fn.public, false); assert.ok(fn.proconfig.includes('search_path=""')); if (fn.runtime || fn.operator) assert.equal(fn.prosecdef, true); }
  const tables = (await admin.query(`SELECT c.relname,c.relrowsecurity,pg_get_userbyid(c.relowner) owner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='linky_private' AND c.relkind='r'`)).rows;
  assert.equal(tables.length, 8);
  for (const table of tables) { assert.equal(table.relrowsecurity, true); assert.equal(table.owner, 'linky_function_owner'); }
  for (const sql of ['SELECT owner_key_hash FROM linky_private.workspaces', "CREATE TABLE linky_private.unowned(id int)", 'SET ROLE linky_function_owner', "SELECT linky_private._sha('x')", `SELECT linky_private.operator_provision('${randomUUID()}'::uuid,'{}'::jsonb)`]) {
    await assert.rejects(runtime.query(sql), error => error.code === '42501');
  }
  await assert.rejects(operator.query("SELECT linky_private.owner_connect(repeat('a',64),'{}'::jsonb)"), error => error.code === '42501');
});

test('capabilities and composite ownership cannot cross workspace or purpose', async () => {
  const a = await workspace(), b = await workspace(), l = await link(a), g = await grant(a, l);
  await denied(call('owner_list_links', b.hash, { workspaceId: a.id }), 'linky_denied');
  await denied(call('owner_connect', g.hash, {}), 'linky_denied');
  await denied(call('recipient_inspect', a.hash, { grantId: g.grantId }), 'linky_denied');
  await denied(call('owner_list_grants', b.hash, { workspaceId: b.id, linkId: l.linkId }), 'linky_scope');
  await denied(grant(b, { ...l, version: 1 }), 'linky_scope');
  const foreign = await link(b);
  await denied(grant(a, { ...l, version: g.version }, { revisionId: foreign.revisionId }), 'linky_scope');
});

test('create replay returns original acknowledgement before later versions and changed scope conflicts', async () => {
  const w = await workspace(), l = await link(w);
  const changed = await call('owner_set_link_state', w.hash, { workspaceId: w.id, mutationKey: randomUUID(), linkId: l.linkId, expectedVersion: 1, state: 'paused' });
  assert.equal(changed.version, 2);
  assert.deepEqual(await call('owner_create_link', w.hash, l.payload), { workspaceId: w.id, linkId: l.linkId, revisionId: l.revisionId, version: 1, replayed: true });
  await denied(call('owner_create_link', w.hash, { ...l.payload, linkId: randomUUID(), revisionId: randomUUID() }), 'linky_conflict');
});

test('immutable destination revisions keep existing grants pinned after label and campaign edits', async () => {
  const w = await workspace(), l = await link(w), g = await grant(w, l);
  const newRevision = randomUUID();
  const revised = await call('owner_revise_link', w.hash, { workspaceId: w.id, mutationKey: randomUUID(), linkId: l.linkId,
    revisionId: newRevision, expectedVersion: g.version, label: 'Edited label', destination: 'https://www.iana.org/about',
    campaign: { ...campaign, campaign: 'edited' }, safety: safe('www.iana.org') });
  assert.equal(revised.version, 3);
  const result = await redeem(g);
  assert.equal(result.destination, l.payload.destination); assert.equal(result.revisionId, l.revisionId);
  const rows = (await call('owner_list_links', w.hash, { workspaceId: w.id, limit: 50, after: null, state: null, search: '' })).links;
  assert.equal(rows[0].label, 'Edited label'); assert.equal(rows[0].currentRevisionId, newRevision); assert.equal(rows[0].campaign.campaign, 'edited');
  await denied(admin.query("UPDATE linky_private.destination_revisions SET destination_url='https://www.iana.org/changed' WHERE id=$1", [l.revisionId]), 'linky_immutable');
});

test('inspection reveals only bounded host metadata and never consumes or creates attribution', async () => {
  const w = await workspace(), l = await link(w), g = await grant(w, l);
  for (let i = 0; i < 2; i++) {
    const view = await call('recipient_inspect', g.hash, { grantId: g.grantId });
    assert.deepEqual(Object.keys(view).sort(), ['expiresAt','grantId','hostname','label','linkId','remainingUses','safety'].sort());
    assert.equal(view.hostname, 'www.iana.org'); assert.equal(view.remainingUses, 1); assert.ok(!JSON.stringify(view).includes(l.payload.destination));
  }
  assert.deepEqual(await counters(g), { used_count: 0, receipts: 0, events: 0, audits: 0 });
});

test('two concurrent final-use redemptions have exactly one durable winner', async () => {
  const w = await workspace(), l = await link(w), g = await grant(w, l);
  const outcomes = await Promise.allSettled([redeem(g), redeem(g)]);
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
  const failure = outcomes.find(row => row.status === 'rejected').reason;
  assert.equal(failure.code, 'P0001'); assert.equal(failure.message, 'linky_exhausted');
  assert.deepEqual(await counters(g), { used_count: 1, receipts: 1, events: 1, audits: 1 });
});

test('concurrent identical keys and discarded acknowledgements replay one receipt even at capacity', async () => {
  const w = await workspace(), l = await link(w), g = await grant(w, l), key = randomUUID();
  const results = await Promise.all([redeem(g, key), redeem(g, key)]);
  assert.equal(results[0].receiptId, results[1].receiptId); assert.deepEqual(results.map(row => row.replayed).sort(), [false, true]);
  const replay = await redeem(g, key); // Caller can discard an acknowledgement without inventing transport-loss proof.
  assert.equal(replay.receiptId, results[0].receiptId); assert.equal(replay.replayed, true); assert.equal(replay.useNumber, 1);
  assert.deepEqual(await counters(g), { used_count: 1, receipts: 1, events: 1, audits: 1 });
});

test('revocation freshly denies a previously committed receipt and its retry acknowledgement is stable', async () => {
  const w = await workspace(), l = await link(w), g = await grant(w, l), key = randomUUID(); await redeem(g, key);
  const request = { workspaceId: w.id, mutationKey: randomUUID(), linkId: l.linkId, grantId: g.grantId, expectedVersion: g.version };
  const ack = await call('owner_revoke_grant', w.hash, request);
  assert.equal(ack.version, 3); assert.deepEqual(await call('owner_revoke_grant', w.hash, request), { ...ack, replayed: true });
  await denied(redeem(g, key), 'linky_revoked'); await denied(call('recipient_inspect', g.hash, { grantId: g.grantId }), 'linky_revoked');
  assert.deepEqual(await counters(g), { used_count: 1, receipts: 1, events: 1, audits: 1 });
});

test('paused blocked and closed lifetimes cannot redisclose an old destination', async () => {
  const w = await workspace(), l = await link(w), g = await grant(w, l), key = randomUUID(); await redeem(g, key);
  let version = g.version;
  for (const state of ['paused', 'blocked', 'active']) {
    const ack = await call('owner_set_link_state', w.hash, { workspaceId: w.id, mutationKey: randomUUID(), linkId: l.linkId, expectedVersion: version, state }); version = ack.version;
    if (state !== 'active') await denied(redeem(g, key), 'linky_inactive');
  }
  assert.equal((await redeem(g, key)).replayed, true);
  await call('owner_close', w.hash, { workspaceId: w.id, mutationKey: randomUUID(), expectedOwnerKeyVersion: 1 });
  await denied(redeem(g, key), 'linky_closed'); await denied(call('owner_connect', w.hash, {}), 'linky_closed');
});

test('expiry is checked with database wall time after an observed lock wait', async () => {
  const w = await workspace(), l = await link(w), g = await grant(w, l, { expiresAt: new Date(Date.now() + 2000).toISOString() });
  const holder = await admin.connect(), waiter = await runtime.connect();
  let pending;
  try {
    const pid = (await waiter.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('BEGIN'); await holder.query('SELECT id FROM linky_private.links WHERE id=$1 FOR UPDATE', [l.linkId]);
    pending = redeem(g, randomUUID(), waiter).then(value => ({ value }), error => ({ error }));
    const deadline = Date.now() + 3000; let blocked = false;
    while (Date.now() < deadline) { blocked = (await admin.query("SELECT wait_event_type='Lock' blocked FROM pg_catalog.pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.blocked; if (blocked) break; await delay(25); }
    assert.equal(blocked, true, 'actual recipient backend waited on the held link lock');
    await holder.query('SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.05)', [g.payload.expiresAt]);
    await holder.query('COMMIT');
    const outcome = await pending; assert.equal(outcome.error?.message, 'linky_expired'); assert.equal(outcome.error?.code, 'P0001');
    assert.deepEqual(await counters(g), { used_count: 0, receipts: 0, events: 0, audits: 0 });
  } finally {
    await holder.query('ROLLBACK'); if (pending) await pending; holder.release(); waiter.release();
  }
});

test('owner compare-and-swap races have one winner and failed writes leave no receipt', async () => {
  const w = await workspace(), l = await link(w);
  const requests = ['paused', 'blocked'].map(state => ({ workspaceId: w.id, mutationKey: randomUUID(), linkId: l.linkId, expectedVersion: 1, state }));
  const outcomes = await Promise.allSettled(requests.map(payload => call('owner_set_link_state', w.hash, payload)));
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(row => row.status === 'rejected').reason.message, 'linky_conflict');
  const winner = outcomes.findIndex(row => row.status === 'fulfilled');
  assert.deepEqual(await call('owner_set_link_state', w.hash, requests[winner]), { ...outcomes[winner].value, replayed: true });
  assert.equal((await admin.query("SELECT count(*)::int n FROM linky_private.mutation_receipts WHERE workspace_id=$1 AND operation='set_link_state'", [w.id])).rows[0].n, 1);
});

test('mutation keys are unique across resources and conflicting writes roll back atomically', async () => {
  const w = await workspace(), a = await link(w), b = await link(w), key = randomUUID();
  const outcomes = await Promise.allSettled([a,b].map(l => call('owner_set_link_state', w.hash, { workspaceId: w.id, mutationKey: key, linkId: l.linkId, expectedVersion: 1, state: 'paused' })));
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1); assert.equal(outcomes.find(row => row.status === 'rejected').reason.message, 'linky_conflict');
  const rows = (await admin.query('SELECT state,version FROM linky_private.links WHERE workspace_id=$1 ORDER BY version', [w.id])).rows;
  assert.deepEqual(rows, [{ state: 'active', version: '1' }, { state: 'paused', version: '2' }]);
});

test('rotation authenticates current owner before replay and operator recovery has a separate capability', async () => {
  const w = await workspace(), l = await link(w), nextHash = capability('lyo');
  const request = { workspaceId: w.id, mutationKey: randomUUID(), newOwnerHash: nextHash, expectedOwnerKeyVersion: 1 };
  const ack = await call('owner_rotate', w.hash, request); assert.equal(ack.ownerKeyVersion, 2);
  await denied(call('owner_create_link', w.hash, l.payload), 'linky_denied'); await denied(call('owner_rotate', w.hash, request), 'linky_denied');
  assert.deepEqual(await call('owner_rotate', nextHash, request), { ...ack, replayed: true });
  assert.equal((await call('owner_create_link', nextHash, l.payload)).replayed, true);
  const recovered = capability('lyo');
  const recovery = { workspaceId: w.id, mutationKey: randomUUID(), newOwnerHash: recovered, expectedOwnerKeyVersion: 2 };
  assert.equal((await operate('operator_recover_owner', recovery, w.operatorId)).ownerKeyVersion, 3);
  await denied(call('owner_connect', nextHash, {}), 'linky_denied'); assert.equal((await call('owner_connect', recovered, {})).workspace.ownerKeyVersion, 3);
});

test('attribution insert failure rolls back counter receipt and audit before a same-key retry', async () => {
  const w = await workspace(), l = await link(w), g = await grant(w, l), key = randomUUID();
  // A fixed test-owned trigger faults only this disposable workspace.
  await admin.query(`CREATE FUNCTION linky_private.authored_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${w.id}'::uuid THEN RAISE EXCEPTION 'authored_attribution_fault'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER authored_receipt_fault BEFORE INSERT ON linky_private.attribution_events FOR EACH ROW EXECUTE FUNCTION linky_private.authored_receipt_fault()`);
  try {
    await assert.rejects(redeem(g, key), error => error.message === 'authored_attribution_fault');
    assert.deepEqual(await counters(g), { used_count: 0, receipts: 0, events: 0, audits: 0 });
  } finally { await admin.query('DROP TRIGGER authored_receipt_fault ON linky_private.attribution_events; DROP FUNCTION linky_private.authored_receipt_fault()'); }
  assert.equal((await redeem(g, key)).useNumber, 1); assert.deepEqual(await counters(g), { used_count: 1, receipts: 1, events: 1, audits: 1 });
});

test('bounded reports retain pinned campaigns and distinguish truncation from conversions', async () => {
  const w = await workspace(), l = await link(w), g = await grant(w, l, { maxUses: 2 }); await redeem(g); await redeem(g);
  const report = await call('owner_report', w.hash, { workspaceId: w.id, from: null, to: null, limit: 1 });
  assert.equal(report.redemptions, 1); assert.equal(report.coverage.recordCount, 1); assert.equal(report.coverage.truncated, true); assert.equal(report.coverage.kind, 'committed_redemptions'); assert.equal(report.conversionsAvailable, false);
  assert.deepEqual(report.campaigns, [{ campaign, redemptions: 1 }]);
  const complete = await call('owner_report', w.hash, { workspaceId: w.id, limit: 50 });
  assert.equal(complete.redemptions, 2); assert.equal(complete.coverage.truncated, false); assert.deepEqual(complete.campaigns, [{ campaign, redemptions: 2 }]);
  const other = await workspace(); assert.equal((await call('owner_report', other.hash, { workspaceId: other.id })).redemptions, 0);
});

test('closed request shapes and address checks reject executable private and forged safety inputs', async () => {
  const w = await workspace();
  for (const destination of ['javascript:alert(1)', 'https://user:password@www.iana.org/', 'https://127.0.0.1/', 'http://10.0.0.1/', 'https://www.iana.org:8443/', 'https://www.iana.org/\nprivate']) {
    await denied(link(w, { destination }), 'linky_invalid');
  }
  await denied(link(w, { safety: { ...safe('www.iana.org'), reputation: 'safe' } }), 'linky_invalid');
  await denied(link(w, { campaign: { ...campaign, owner: true } }), 'linky_invalid');
  const forbiddenContent = `lyo_${'a'.repeat(64)}`; // Authored, non-operational token-shaped text.
  await denied(link(w, { label: forbiddenContent }), 'linky_invalid');
  await denied(link(w, { campaign: { ...campaign, source: forbiddenContent } }), 'linky_invalid');
  await denied(operate('operator_provision', { workspaceId: randomUUID(), mutationKey: randomUUID(), name: forbiddenContent, ownerHash: capability('lyo') }), 'linky_invalid');
  await denied(call('owner_list_links', w.hash, { workspaceId: w.id, owner: true }), 'linky_invalid');
  const l = await link(w);
  await denied(grant(w, l, { recipientHash: 1 }), 'linky_invalid');
  const result = await call('owner_list_links', w.hash, { workspaceId: w.id, limit: 1, after: null, state: null, search: 'Authored' });
  assert.equal(result.links.length, 1); assert.equal(result.nextCursor, l.linkId);
  assert.deepEqual((await call('owner_list_links', w.hash, { workspaceId: w.id, limit: 1, after: result.nextCursor })).links, []);
});

test('receipt event and audit history remain append-only even to direct privileged writes', async () => {
  const w = await workspace(), l = await link(w), g = await grant(w, l); await redeem(g);
  for (const table of ['redemption_receipts','attribution_events','mutation_receipts','audit_events']) {
    await denied(admin.query(`DELETE FROM linky_private.${table} WHERE workspace_id=$1`, [w.id]), 'linky_immutable');
  }
  await denied(admin.query('UPDATE linky_private.grants SET max_uses=2 WHERE id=$1', [g.grantId]), 'linky_immutable');
  assert.deepEqual(await counters(g), { used_count: 1, receipts: 1, events: 1, audits: 1 });
});
