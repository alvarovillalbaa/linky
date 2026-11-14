import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateCapability, hashCapability } from '../../server/capabilities.mjs';

export const expectedUrl = 'postgresql://postgres:authored-ci-only@127.0.0.1:5432/linky_origin_checks';
export function requireDisposable() {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.LINKY_DISPOSABLE_DATABASE, 'true');
  assert.equal(process.env.LINKY_DISPOSABLE_DB, 'linky-pg17-origin-v3'); assert.equal(process.env.LINKY_TEST_DATABASE_URL, expectedUrl);
}
export const functions = new Set(['owner_connect','owner_rotate','owner_close','owner_create_link','owner_revise_link','owner_set_link_state',
  'owner_issue_grant','owner_revoke_grant','owner_list_links','owner_list_grants','recipient_inspect','recipient_redeem','owner_report',
  'owner_issue_conversion_credential','owner_list_conversion_credentials','owner_revoke_conversion_credential','conversion_ingest','owner_bulk_create_links','owner_attribution_report',
  'owner_issue_origin_credential','owner_list_origin_credentials','owner_revoke_origin_credential','recipient_resource_inspect','recipient_prepare_resource_access','origin_authorize']);
export const runtimeUrl = 'postgresql://linky_runtime:authored-origin-runtime@127.0.0.1:5432/linky_origin_checks';
export const operatorUrl = 'postgresql://linky_operator:authored-origin-operator@127.0.0.1:5432/linky_origin_checks';
export async function pools() {
  requireDisposable(); const { default: pg } = await import('pg');
  const options = { max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, statement_timeout: 12000, lock_timeout: 8000, application_name: 'linky-origin-disposable-v3' };
  const admin = new pg.Pool({ ...options, connectionString: expectedUrl }), runtime = new pg.Pool({ ...options, connectionString: runtimeUrl }), operator = new pg.Pool({ ...options, connectionString: operatorUrl });
  const row = (await admin.query("SELECT current_database() name,current_setting('server_version_num')::int version,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual({ name: row.name, major: Math.floor(row.version / 10000), marker: row.marker }, { name: 'linky_origin_checks', major: 17, marker: 'linky-origin-disposable-ci-v3' });
  const call = async (name, digest, payload, client = runtime) => {
    assert(functions.has(name)); return (await client.query(`SELECT linky_private.${name}($1::text,$2::jsonb) result`, [digest, JSON.stringify(payload)])).rows[0].result;
  };
  const workspace = async () => {
    const w = { id: randomUUID(), key: generateCapability('owner') }; w.hash = hashCapability(w.key, 'owner');
    await operator.query('SELECT linky_private.operator_provision($1::uuid,$2::jsonb)', [randomUUID(), JSON.stringify({ workspaceId: w.id, mutationKey: randomUUID(), name: 'Authored protected resources', ownerHash: w.hash })]); return w;
  };
  const link = async (w, destination = 'https://resource.example.com/private.bin?scope=authored') => {
    const payload = { workspaceId: w.id, mutationKey: randomUUID(), linkId: randomUUID(), revisionId: randomUUID(), slug: 'v3_' + randomUUID(), label: 'Authored protected file', destination,
      campaign: { source: 'authored', medium: 'origin-ci', campaign: 'resource-v3' }, safety: { policyVersion: 'linky-address-v1', hostname: new URL(destination).hostname, result: 'accepted', reputation: 'unchecked' } };
    return { ...await call('owner_create_link', w.hash, payload), payload };
  };
  const receipt = async (w, l, expiry = new Date(Date.now() + 120000).toISOString()) => {
    const key = generateCapability('recipient'), digest = hashCapability(key, 'recipient'), grantId = randomUUID(), redemptionKey = randomUUID();
    const issued = await call('owner_issue_grant', w.hash, { workspaceId: w.id, mutationKey: randomUUID(), linkId: l.linkId, revisionId: l.revisionId, expectedVersion: l.version, grantId, recipientHash: digest, label: 'Authored one-use grant', maxUses: 1, expiresAt: expiry });
    const ack = await call('recipient_redeem', digest, { grantId, redemptionKey }); return { ...ack, key, hash: digest, linkVersion: issued.version, redemptionKey, expiresAt: expiry };
  };
  const credential = async (w, l, overrides = {}) => {
    const key = generateCapability('origin'), hash = hashCapability(key, 'origin');
    const payload = { workspaceId: w.id, mutationKey: randomUUID(), linkId: l.linkId, revisionId: l.revisionId, expectedVersion: l.version, credentialId: randomUUID(), originHash: hash, label: 'Authored host', expiresAt: new Date(Date.now() + 120000).toISOString(), ...overrides };
    return { ...await call('owner_issue_origin_credential', w.hash, payload), key, hash, payload };
  };
  const prepare = async (r, expectedAccessVersion = 0) => {
    const key = generateCapability('access'), hash = hashCapability(key, 'access');
    const payload = { grantId: r.grantId, receiptId: r.receiptId, accessId: randomUUID(), accessHash: hash, expectedAccessVersion };
    return { ...await call('recipient_prepare_resource_access', r.hash, payload), key, hash, payload };
  };
  const cohort = async (options = {}) => {
    const w = await workspace(), l = await link(w), r = await receipt(w, l, options.grantExpiry), c = await credential(w, { ...l, version: r.linkVersion }, options.credential), a = await prepare(r);
    return { w, l, r, c, a };
  };
  const authorize = (c, a, client) => call('origin_authorize', c.hash, { credentialId: c.credentialId, accessId: a.accessId, accessHash: a.hash }, client);
  return { admin, runtime, operator, call, workspace, link, receipt, credential, prepare, cohort, authorize, close: async () => { await Promise.all([runtime.end(), operator.end(), admin.end()]); } };
}
export const denied = (work, code) => assert.rejects(work, error => error.code === 'P0001' && error.message === code);
