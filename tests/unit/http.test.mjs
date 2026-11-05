import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { ServerResponse } from 'node:http';
import { Readable, Duplex } from 'node:stream';
import test from 'node:test';
import { createHandler, API_ROUTES } from '../../server/http.mjs';
import vercelHandler from '../../api/v1.mjs';
import { generateCapability, hashCapability } from '../../server/capabilities.mjs';
import { createPostgresRepository, parseConnectionConfig } from '../../server/postgres.mjs';

const origin = 'https://linky.example';
// Authored, non-operational capability material; no real account or database.
const owner = `lyo_${'a'.repeat(64)}`, recipient = `lyr_${'b'.repeat(64)}`;
const ids = { workspaceId: '10000000-0000-4000-8000-000000000001', mutationKey: '10000000-0000-4000-8000-000000000002',
  linkId: '10000000-0000-4000-8000-000000000003', revisionId: '10000000-0000-4000-8000-000000000004',
  grantId: '10000000-0000-4000-8000-000000000005', redemptionKey: '10000000-0000-4000-8000-000000000006',
  receiptId: '10000000-0000-4000-8000-000000000007' };
const safety = { policyVersion: 'linky-address-v1', hostname: 'example.com', result: 'accepted', reputation: 'unchecked' };
const draft = { title: 'Authored link', destination: 'https://example.com/guide?x=%2f&utm_source=old#part', source: 'review', medium: 'share', campaign: 'authored' };
const create = () => ({ workspaceId: ids.workspaceId, mutationKey: ids.mutationKey, linkId: ids.linkId, revisionId: ids.revisionId, slug: 'authored-link', draft: { ...draft } });
const inspect = () => ({ grantId: ids.grantId, linkId: ids.linkId, label: 'Authored recipient', hostname: 'example.com', safety, expiresAt: '2030-01-01T00:00:00.000Z', remainingUses: 1 });
const redeemed = () => ({ receiptId: ids.receiptId, grantId: ids.grantId, linkId: ids.linkId, revisionId: ids.revisionId,
  useNumber: 1, redeemedAt: '2026-11-05T12:00:00.000Z', destination: 'https://example.com/guide', replayed: false });
function request(path, payload, { authorization = owner, headers = {}, method = 'POST', raw } = {}) {
  return new Request(origin + '/api/v1' + path, { method, headers: { origin, 'content-type': 'application/json',
    ...(authorization === null ? {} : { authorization: `Bearer ${authorization}` }), ...headers },
    ...(['GET', 'HEAD'].includes(method) ? {} : { body: raw ?? JSON.stringify(payload) }) });
}
function fixture(method, implementation) {
  const calls = [];
  const repository = { [method]: async (...args) => { calls.push(structuredClone(args)); return implementation(...args); } };
  return { calls, handler: createHandler({ repository, origin }) };
}
async function code(response, status, expected) {
  assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: { code: expected } });
}
async function deployedRequest(url, { method = 'GET', raw = Buffer.alloc(0), headers = {} } = {}) {
  const input = Readable.from([raw]);
  Object.assign(input, { url, method, headers, httpVersionMajor: 1, httpVersionMinor: 1 });
  Object.defineProperty(input, 'body', { get() { assert.fail('The adapter must read raw bytes, not a parsed platform body.'); } });
  const chunks = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  input.socket = socket;
  const output = new ServerResponse(input);
  output.useChunkedEncodingByDefault = false; output.shouldKeepAlive = false; output.assignSocket(socket);
  const completed = once(output, 'finish');
  try {
    await vercelHandler(input, output); await completed;
    const wire = Buffer.concat(chunks).toString('utf8'), split = wire.indexOf('\r\n\r\n');
    assert(split >= 0, 'A real ServerResponse must write a complete HTTP header.');
    return { status: output.statusCode, headers: wire.slice(0, split).toLowerCase(), body: wire.slice(split + 4) };
  } finally { input.destroy(); socket.destroy(); }
}

test('public GET and HEAD status are inert while protected GET cannot disclose or redeem', async () => {
  const f = fixture('recipientRedeem', redeemed);
  const status = await f.handler(request('/status', undefined, { method: 'GET', authorization: null }));
  assert.deepEqual(await status.json(), { service: 'linky', configuration: 'present', database: 'unverified', conversionsAvailable: false });
  const head = await f.handler(request('/status', undefined, { method: 'HEAD' }));
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  await code(await f.handler(request('/recipient/redeem', undefined, { method: 'GET', authorization: null })), 405, 'method_not_allowed');
  assert.equal(f.calls.length, 0);
});

test('missing or foreign origins and cross-site context fail before repository access', async () => {
  const f = fixture('ownerConnect', () => assert.fail('Origin must be checked first.'));
  for (const value of ['', 'https://other.example', 'https://linky.example.evil']) {
    await code(await f.handler(request('/owner/connect', {}, { headers: { origin: value } })), 403, 'origin_denied');
  }
  const response = await f.handler(request('/owner/connect', {}, { headers: { 'sec-fetch-site': 'cross-site' } }));
  await code(response, 403, 'origin_denied'); assert.equal(response.headers.has('access-control-allow-origin'), false);
  assert.equal(f.calls.length, 0);
});

test('owner and recipient credentials are purpose-separated and absent credentials never reach SQL', async () => {
  const f = fixture('ownerConnect', () => assert.fail('Credential validation must be checked first.'));
  await code(await f.handler(request('/owner/connect', {}, { authorization: null })), 401, 'credential_required');
  for (const authorization of [recipient, 'lyo_short', owner.toUpperCase()]) await code(await f.handler(request('/owner/connect', {}, { authorization })), 401, 'invalid_credential');
  await code(await f.handler(request('/recipient/inspect', { grantId: ids.grantId, recipientKey: recipient })), 401, 'invalid_credential');
  assert.equal(f.calls.length, 0);
  assert.notEqual(hashCapability(owner, 'owner'), hashCapability(recipient, 'recipient'));
  assert.match(generateCapability('owner'), /^lyo_[0-9a-f]{64}$/u);
  assert.match(generateCapability('recipient'), /^lyr_[0-9a-f]{64}$/u);
});

test('JSON media type UTF-8 shape extra keys and actual stream byte bounds fail closed', async () => {
  const f = fixture('ownerConnect', () => assert.fail('Invalid bodies cannot call the repository.'));
  await code(await f.handler(request('/owner/connect', {}, { headers: { 'content-type': 'text/plain' } })), 415, 'json_required');
  for (const raw of ['{', 'null', '[]', '{"owner":true}', '{"__proto__":{"admin":true}}']) await code(await f.handler(request('/owner/connect', {}, { raw })), 400, raw === '{' ? 'invalid_json' : 'invalid_request');
  await code(await f.handler(request('/owner/connect', {}, { raw: new Uint8Array([0xff]) })), 400, 'invalid_json');
  await code(await f.handler(request('/owner/connect', {}, { raw: ' '.repeat(32 * 1024 + 1) })), 413, 'request_too_large');
  await code(await f.handler(request('/owner/connect', {}, { headers: { 'content-length': '32769' } })), 413, 'request_too_large');
  assert.equal(f.calls.length, 0);
});

test('owner connect forwards only a purpose-bound digest and returns no credential material', async () => {
  const f = fixture('ownerConnect', () => ({ workspace: { id: ids.workspaceId, name: 'Authored workspace', state: 'active', ownerKeyVersion: 1 } }));
  const response = await f.handler(request('/owner/connect', {}));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(f.calls, [[createHash('sha256').update(owner).digest('hex'), {}]]);
  const text = await response.text(); assert.equal(text.includes(owner), false); assert.equal(text.includes(f.calls[0][0]), false);
});

test('link creation recomputes the destination campaign and safety instead of trusting client authority', async () => {
  const ack = { workspaceId: ids.workspaceId, linkId: ids.linkId, revisionId: ids.revisionId, version: 1, replayed: false };
  const f = fixture('ownerCreateLink', () => ack);
  const response = await f.handler(request('/links/create', create()));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ...ack, mutationKey: ids.mutationKey });
  const payload = f.calls[0][1]; assert.equal(payload.label, draft.title);
  assert.equal(payload.destination, 'https://example.com/guide?x=%2f&utm_source=review&utm_medium=share&utm_campaign=authored#part');
  assert.deepEqual(payload.campaign, { source: 'review', medium: 'share', campaign: 'authored' });
  assert.equal(payload.safety.hostname, 'example.com'); assert.equal(payload.safety.reputation, 'unchecked');
  assert.equal(Object.hasOwn(payload, 'draft'), false); assert.equal(Object.hasOwn(payload, 'owner'), false);
  await code(await f.handler(request('/links/create', { ...create(), safety: { reputation: 'safe' } })), 400, 'invalid_request');
  assert.equal(f.calls.length, 1);
});

test('blocked destinations malformed UUIDs and forged success scope are not accepted', async () => {
  const f = fixture('ownerCreateLink', () => ({ workspaceId: ids.workspaceId, linkId: ids.grantId, revisionId: ids.revisionId, version: 1, replayed: false }));
  const privateDraft = create(); privateDraft.draft.destination = 'http://127.0.0.1/private';
  await code(await f.handler(request('/links/create', privateDraft)), 400, 'destination_invalid');
  await code(await f.handler(request('/links/create', { ...create(), linkId: 'not-a-uuid' })), 400, 'invalid_request');
  await code(await f.handler(request('/links/create', create())), 503, 'service_unavailable');
  assert.equal(f.calls.length, 1);
});

test('grant issuance retains explicit CAS and sends a recipient digest without echoing its key', async () => {
  const ack = { workspaceId: ids.workspaceId, linkId: ids.linkId, grantId: ids.grantId, revisionId: ids.revisionId, version: 2, replayed: false };
  const f = fixture('ownerIssueGrant', () => ack);
  const input = { workspaceId: ids.workspaceId, mutationKey: ids.mutationKey, linkId: ids.linkId, revisionId: ids.revisionId,
    expectedVersion: 1, grantId: ids.grantId, recipientKey: recipient, label: 'Authored recipient', maxUses: 1, expiresAt: '2030-01-01T00:00:00.000Z' };
  const response = await f.handler(request('/grants/issue', input));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ...ack, mutationKey: ids.mutationKey });
  assert.equal(f.calls[0][1].expectedVersion, 1); assert.equal(f.calls[0][1].recipientHash, createHash('sha256').update(recipient).digest('hex'));
  assert.equal(Object.hasOwn(f.calls[0][1], 'recipientKey'), false);
  for (const override of [{ maxUses: 0 }, { maxUses: 1_000_001 }, { expiresAt: '2030-02-30T00:00:00.000Z' }, { recipientKey: owner }]) {
    const failed = await f.handler(request('/grants/issue', { ...input, ...override })); assert(failed.status >= 400 && failed.status < 500);
  }
  assert.equal(f.calls.length, 1);
});

test('ordinary link content and grant labels cannot persist recognized Linky credentials', async () => {
  const links = fixture('ownerCreateLink', () => assert.fail('Credential-bearing content must never reach SQL.'));
  const grants = fixture('ownerIssueGrant', () => assert.fail('Credential-bearing labels must never reach SQL.'));
  for (const token of [owner, recipient]) {
    for (const field of ['title', 'destination', 'source', 'medium', 'campaign']) {
      const input = create();
      input.draft[field] = field === 'destination' ? `https://example.com/${token}` : `Authored ${token}`;
      await code(await links.handler(request('/links/create', input)), 400, 'destination_invalid');
    }
    await code(await grants.handler(request('/grants/issue', { workspaceId: ids.workspaceId, mutationKey: ids.mutationKey,
      linkId: ids.linkId, revisionId: ids.revisionId, expectedVersion: 1, grantId: ids.grantId,
      recipientKey: recipient, label: `Authored ${token}`, maxUses: 1, expiresAt: '2030-01-01T00:00:00.000Z' })), 400, 'invalid_request');
  }
  assert.equal(links.calls.length, 0); assert.equal(grants.calls.length, 0);
});

test('recipient inspection is explicit metadata-only and accidental destination or digest disclosure fails closed', async () => {
  let output = inspect(); const f = fixture('recipientInspect', () => output);
  const input = { grantId: ids.grantId, recipientKey: recipient };
  const result = await f.handler(request('/recipient/inspect', input, { authorization: null }));
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), inspect());
  assert.deepEqual(f.calls[0][1], { grantId: ids.grantId });
  output = { ...inspect(), destination: 'https://example.com/private' };
  await code(await f.handler(request('/recipient/inspect', input, { authorization: null })), 503, 'service_unavailable');
  output = { ...inspect(), recipientHash: 'f'.repeat(64) };
  await code(await f.handler(request('/recipient/inspect', input, { authorization: null })), 503, 'service_unavailable');
});

test('redemption waits for its repository outcome and never retries an uncertain write', async () => {
  let resolve; const barrier = new Promise(done => { resolve = done; });
  const f = fixture('recipientRedeem', () => barrier);
  const input = { grantId: ids.grantId, recipientKey: recipient, redemptionKey: ids.redemptionKey };
  let settled = false;
  const waiting = f.handler(request('/recipient/redeem', input, { authorization: null })).then(response => { settled = true; return response; });
  await new Promise(done => setImmediate(done)); assert.equal(settled, false); assert.equal(f.calls.length, 1);
  resolve(redeemed()); const result = await waiting;
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), redeemed());
  assert.deepEqual(f.calls[0][1], { grantId: ids.grantId, redemptionKey: ids.redemptionKey });
  const broken = fixture('recipientRedeem', () => { throw new Error('Authored uncertain commit detail with ' + recipient); });
  await code(await broken.handler(request('/recipient/redeem', input, { authorization: null })), 503, 'service_unavailable');
  assert.equal(broken.calls.length, 1);
});

test('finite SQL denials map to public errors while arbitrary driver details remain private', async () => {
  const mappings = [['linky_denied', 403, 'access_denied'], ['linky_conflict', 409, 'conflict'], ['linky_expired', 410, 'grant_expired'], ['linky_revoked', 410, 'grant_revoked'], ['linky_exhausted', 409, 'uses_exhausted']];
  for (const [message, status, expected] of mappings) {
    const f = fixture('ownerConnect', () => { throw Object.assign(new Error(message), { code: 'P0001', detail: owner }); });
    await code(await f.handler(request('/owner/connect', {})), status, expected);
  }
  for (const message of ['constructor', '__proto__', `SELECT private ${owner}`]) {
    const f = fixture('ownerConnect', () => { throw Object.assign(new Error(message), { code: 'P0001', detail: recipient }); });
    await code(await f.handler(request('/owner/connect', {})), 503, 'service_unavailable');
  }
});

test('bounded reports preserve aggregate counts and explicit cohort coverage without inventing conversions', async () => {
  const output = { redemptions: 1, campaigns: [{ campaign: { source: 'authored', medium: '', campaign: '' }, redemptions: 1 }],
    coverage: { kind: 'committed_redemptions', from: '2026-11-01T00:00:00.000Z', to: '2026-11-05T00:00:00.000Z', limit: 50, recordCount: 1, truncated: false }, conversionsAvailable: false };
  const f = fixture('ownerReport', () => output);
  const response = await f.handler(request('/reports/redemptions', { workspaceId: ids.workspaceId, from: null, to: null, limit: 50 }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), output);
  assert.deepEqual(f.calls[0][1], { workspaceId: ids.workspaceId, from: null, to: null, limit: 50 });
});

test('private connection parsing preserves verified TLS and rejects URL overrides or privileged runtime names', async () => {
  const direct = parseConnectionConfig({ connectionString: 'postgres://linky_runtime:authored-password@database.example/linky' });
  assert.deepEqual(direct.ssl, { rejectUnauthorized: true }); assert.equal(direct.max, 1); assert.equal(direct.allowExitOnIdle, true);
  const pooled = parseConnectionConfig({ connectionString: 'postgres://linky_runtime.abcdefghijklmnopqrst:authored-password@pooler.example/linky', ca: 'AUTHORED TEST CA' });
  assert.equal(pooled.ssl.rejectUnauthorized, true); assert.equal(pooled.ssl.ca, 'AUTHORED TEST CA');
  for (const suffix of ['?sslmode=disable', '?host=other.example', '?application_name=override', '#fragment']) {
    assert.throws(() => parseConnectionConfig({ connectionString: 'postgres://linky_runtime:authored-password@database.example/linky' + suffix }), /backend_unconfigured/);
  }
  for (const role of ['postgres', 'service_role', 'linky_owner', 'linky_runtime.evil', 'other_runtime']) {
    await assert.rejects(createPostgresRepository({ connectionString: `postgres://${role}:authored-password@database.example/linky` }), /backend_unconfigured/);
  }
});

test('the Vercel rewrite admits the exact shared route set including inert singleton status', async () => {
  const previousOrigin = process.env.LINKY_PUBLIC_ORIGIN, previousDatabase = process.env.LINKY_DATABASE_URL;
  process.env.LINKY_PUBLIC_ORIGIN = origin; delete process.env.LINKY_DATABASE_URL;
  try {
    for (const route of API_ROUTES) {
      const result = await deployedRequest('/api/v1?linky_route=' + encodeURIComponent(route));
      assert.equal(result.status, route === 'status' ? 200 : 405, route);
      assert(result.headers.includes('cache-control: no-store'));
      if (route === 'status') assert.equal(JSON.parse(result.body).database, 'unverified');
    }
    const head = await deployedRequest('/api/v1?linky_route=status', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.body, '');
    for (const url of ['/api/v1?linky_route=unknown', '/api/v1?linky_route=status&linky_route=status',
      '/api/v1/links/list?linky_route=status', '/api/v1?linky_route=status&recipientKey=authored']) {
      const result = await deployedRequest(url);
      assert.equal(result.status, 400); assert.deepEqual(JSON.parse(result.body), { error: { code: 'invalid_request' } });
    }
  } finally {
    if (previousOrigin === undefined) delete process.env.LINKY_PUBLIC_ORIGIN; else process.env.LINKY_PUBLIC_ORIGIN = previousOrigin;
    if (previousDatabase === undefined) delete process.env.LINKY_DATABASE_URL; else process.env.LINKY_DATABASE_URL = previousDatabase;
  }
});

test('the Vercel adapter preserves strict raw UTF-8 bounds without connecting before validation', async () => {
  const previousOrigin = process.env.LINKY_PUBLIC_ORIGIN, previousDatabase = process.env.LINKY_DATABASE_URL;
  process.env.LINKY_PUBLIC_ORIGIN = origin;
  process.env.LINKY_DATABASE_URL = 'postgres://authored-never-connected:invalid@database.example/linky';
  const headers = { origin, 'content-type': 'application/json' };
  try {
    for (const [raw, status, error] of [[Buffer.from([0xff]), 400, 'invalid_json'],
      [Buffer.alloc(32769, 32), 413, 'request_too_large'], [Buffer.from('{}'), 401, 'credential_required']]) {
      const result = await deployedRequest('/api/v1?linky_route=owner%2Fconnect', { method: 'POST', headers, raw });
      assert.equal(result.status, status); assert.deepEqual(JSON.parse(result.body), { error: { code: error } });
    }
  } finally {
    if (previousOrigin === undefined) delete process.env.LINKY_PUBLIC_ORIGIN; else process.env.LINKY_PUBLIC_ORIGIN = previousOrigin;
    if (previousDatabase === undefined) delete process.env.LINKY_DATABASE_URL; else process.env.LINKY_DATABASE_URL = previousDatabase;
  }
});
