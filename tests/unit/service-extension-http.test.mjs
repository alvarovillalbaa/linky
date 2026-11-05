import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createHandler, API_ROUTES } from '../../server/http.mjs';
import { generateCapability, hashCapability } from '../../server/capabilities.mjs';

const origin = 'https://linky.example';
// Authored values only: no account, database or provider is accessed here.
const owner = `lyo_${'a'.repeat(64)}`, recipient = `lyr_${'b'.repeat(64)}`, ingest = `lyi_${'c'.repeat(64)}`;
const uuid = number => `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const ids = { workspaceId: uuid(1), linkId: uuid(2), revisionId: uuid(3), mutationKey: uuid(4), credentialId: uuid(5), receiptId: uuid(6), eventKey: uuid(7) };
const declaredAt = '2026-11-05T09:00:00.000Z', expiresAt = '2030-01-01T00:00:00.000Z';
const draft = () => ({ title: 'Authored draft', destination: 'https://example.com/guide?retained=%2f&utm_source=old#part', source: 'review', medium: 'share', campaign: 'authored' });
const bulkRow = number => ({ mutationKey: uuid(number * 3 + 10), linkId: uuid(number * 3 + 11), revisionId: uuid(number * 3 + 12), slug: `authored-${number}`, draft: draft() });
const issue = () => ({ ...ids, expectedVersion: 1, ingestKey: ingest, label: 'Authored ingest', expiresAt });
function issueBody() {
  const value = issue(); delete value.receiptId; delete value.eventKey; return value;
}
const event = () => ({ credentialId: ids.credentialId, receiptId: ids.receiptId, eventKey: ids.eventKey,
  kind: 'sale_declared', amountMinor: 0, currency: 'USD', declaredAt });
const ack = () => ({ eventId: uuid(8), workspaceId: ids.workspaceId, linkId: ids.linkId, revisionId: ids.revisionId,
  receiptId: ids.receiptId, eventKey: ids.eventKey, kind: 'sale_declared', acceptedAt: declaredAt, replayed: false });
function request(route, payload, { authorization = owner, suppliedOrigin = origin, method = 'POST', headers = {}, raw } = {}) {
  return new Request(`${origin}/api/v1${route}`, { method, headers: { 'content-type': 'application/json',
    ...(suppliedOrigin === null ? {} : { origin: suppliedOrigin }), ...(authorization === null ? {} : { authorization: `Bearer ${authorization}` }), ...headers },
    ...(['GET', 'HEAD'].includes(method) ? {} : { body: raw ?? JSON.stringify(payload) }) });
}
function fixture(method, implementation) {
  const calls = [];
  return { calls, handler: createHandler({ origin, repository: { [method]: async (...args) => { calls.push(structuredClone(args)); return implementation(...args); } } }) };
}
async function error(response, status, code) { assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: { code } }); }
function committed(row) { return { sourceIndex: row.sourceIndex, mutationKey: row.mutationKey, linkId: row.linkId, revisionId: row.revisionId, status: 'committed', version: 1, error: null }; }
function report() {
  const campaign = { source: 'authored', medium: 'share', campaign: 'review' };
  const coverage = kind => ({ kind, from: '2026-11-01T00:00:00.000Z', to: '2026-11-05T10:00:00.000Z', limit: 50, recordCount: 1, truncated: false });
  return { redemptions: { count: 1, campaigns: [{ campaign, count: 1 }], coverage: coverage('committed_redemptions') },
    declarations: { total: 5, leads: 1, sales: 4, unknownValueSales: 1,
      campaigns: [{ campaign, leads: 1, sales: 4, unknownValueSales: 1 }],
      currencies: [{ currency: 'USD', amountMinor: '18014398509481982', sales: 2 }, { currency: 'EUR', amountMinor: '0', sales: 1 }],
      coverage: { ...coverage('accepted_conversion_declarations'), recordCount: 5 } } };
}

test('ingest capabilities hash their full purpose and cannot substitute for owner or recipient authority', async () => {
  assert.match(generateCapability('ingest'), /^lyi_[0-9a-f]{64}$/u);
  assert.equal(hashCapability(ingest, 'ingest'), createHash('sha256').update(ingest).digest('hex'));
  for (const [token, purpose] of [[owner, 'ingest'], [recipient, 'ingest'], [ingest, 'owner'], [ingest, 'recipient']]) assert.throws(() => hashCapability(token, purpose), /invalid_credential/);
  const f = fixture('conversionIngest', ack);
  for (const authorization of [owner, recipient, null]) await error(await f.handler(request('/conversions/ingest', event(), { authorization, suppliedOrigin: null })), 401, authorization === null ? 'credential_required' : 'invalid_credential');
  assert.equal(f.calls.length, 0);
});

test('only ingestion accepts an absent Origin and its browser requests still reject foreign context and cookies', async () => {
  const f = fixture('conversionIngest', ack);
  const accepted = await f.handler(request('/conversions/ingest', event(), { authorization: ingest, suppliedOrigin: null }));
  assert.equal(accepted.status, 200); assert.deepEqual(f.calls[0], [hashCapability(ingest, 'ingest'), event()]);
  assert.equal(accepted.headers.has('access-control-allow-origin'), false);
  for (const options of [{ suppliedOrigin: 'https://foreign.example' }, { suppliedOrigin: '' }, { headers: { 'sec-fetch-site': 'cross-site' } }]) {
    await error(await f.handler(request('/conversions/ingest', event(), { authorization: ingest, ...options })), 403, 'origin_denied');
  }
  await error(await f.handler(request('/conversions/ingest', event(), { authorization: ingest, suppliedOrigin: null, headers: { cookie: 'authored=unused' } })), 401, 'invalid_credential');
  await error(await f.handler(request('/conversions/ingest?credentialId=forbidden', event(), { authorization: ingest, suppliedOrigin: null })), 400, 'invalid_request');
  await error(await f.handler(request('/conversions/ingest', undefined, { method: 'GET', authorization: ingest, suppliedOrigin: null })), 405, 'method_not_allowed');
  const ownerRoute = fixture('ownerAttributionReport', report);
  await error(await ownerRoute.handler(request('/reports/attribution', { workspaceId: ids.workspaceId, from: null, to: null, limit: 50 }, { suppliedOrigin: null })), 403, 'origin_denied');
  assert.equal(f.calls.length, 1); assert.equal(ownerRoute.calls.length, 0);
});

test('conversion declarations use closed fields canonical dates and exact known or unknown monetary values', async () => {
  const f = fixture('conversionIngest', (_digest, payload) => ({ ...ack(), kind: payload.kind }));
  for (const override of [{ kind: 'lead_declared', amountMinor: null, currency: null }, { amountMinor: null, currency: null }, { amountMinor: Number.MAX_SAFE_INTEGER }]) {
    assert.equal((await f.handler(request('/conversions/ingest', { ...event(), ...override }, { authorization: ingest, suppliedOrigin: null }))).status, 200);
  }
  const invalid = [{ kind: 'lead_declared' }, { amountMinor: -1 }, { amountMinor: 0.1 }, { amountMinor: Number.MAX_SAFE_INTEGER + 1 },
    { amountMinor: '100' }, { amountMinor: null }, { currency: null }, { currency: 'usd' }, { kind: 'purchase_verified' }, { declaredAt: '2026-11-05' }, { campaign: 'cannot-choose' }, { owner: true }];
  for (const override of invalid) await error(await f.handler(request('/conversions/ingest', { ...event(), ...override }, { authorization: ingest, suppliedOrigin: null })), 400, 'invalid_request');
  assert.equal(f.calls.length, 3);
});

test('conversion credential issuance binds scope hashes and committed acknowledgments without returning the key', async () => {
  const result = { workspaceId: ids.workspaceId, linkId: ids.linkId, credentialId: ids.credentialId, revisionId: ids.revisionId, version: 2, replayed: false };
  const f = fixture('ownerIssueConversionCredential', () => result);
  const response = await f.handler(request('/conversion-credentials/issue', issueBody()));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ...result, mutationKey: ids.mutationKey });
  assert.equal(f.calls[0][1].ingestHash, hashCapability(ingest, 'ingest')); assert.equal(Object.hasOwn(f.calls[0][1], 'ingestKey'), false);
  assert.equal(f.calls[0][1].expectedVersion, 1);
  await error(await f.handler(request('/conversion-credentials/issue', { ...issueBody(), ingestKey: recipient })), 401, 'invalid_credential');
  assert.equal(f.calls.length, 1);
});

test('credential administration lists only scoped metadata and revocation preserves CAS and current denials', async () => {
  const credential = { id: ids.credentialId, linkId: ids.linkId, revisionId: ids.revisionId, label: 'Authored ingest', purpose: 'conversion_ingest', expiresAt, revokedAt: null, createdAt: declaredAt };
  let output = { credentials: [credential], nextCursor: null };
  const f = fixture('ownerListConversionCredentials', () => output);
  const input = { workspaceId: ids.workspaceId, linkId: ids.linkId, limit: 50, after: null };
  assert.deepEqual(await (await f.handler(request('/conversion-credentials/list', input))).json(), output);
  output = { credentials: [{ ...credential, ingestHash: 'd'.repeat(64) }], nextCursor: null };
  await error(await f.handler(request('/conversion-credentials/list', input)), 503, 'service_unavailable');
  output = { credentials: [{ ...credential, linkId: uuid(99) }], nextCursor: null };
  await error(await f.handler(request('/conversion-credentials/list', input)), 503, 'service_unavailable');
  const result = { workspaceId: ids.workspaceId, linkId: ids.linkId, credentialId: ids.credentialId, version: 3, replayed: false };
  const revoke = fixture('ownerRevokeConversionCredential', () => result);
  const intent = { workspaceId: ids.workspaceId, mutationKey: ids.mutationKey, linkId: ids.linkId, credentialId: ids.credentialId, expectedVersion: 2 };
  assert.deepEqual(await (await revoke.handler(request('/conversion-credentials/revoke', intent))).json(), { ...result, mutationKey: ids.mutationKey });
  assert.deepEqual(revoke.calls[0][1], intent);
  for (const [message, code] of [['linky_expired', 'credential_expired'], ['linky_revoked', 'credential_revoked']]) {
    const denied = fixture('conversionIngest', () => { throw Object.assign(new Error(message), { code: 'P0001' }); });
    await error(await denied.handler(request('/conversions/ingest', event(), { authorization: ingest, suppliedOrigin: null })), 410, code);
  }
});

test('recognized ingest credentials are refused in ordinary drafts labels and success DTOs', async () => {
  const bulk = fixture('ownerBulkCreateLinks', () => assert.fail('No credential-bearing row may reach SQL.'));
  const row = bulkRow(1); row.draft.title = `Authored ${ingest}`;
  const response = await bulk.handler(request('/links/bulk-create', { workspaceId: ids.workspaceId, rows: [row] }));
  assert.equal(response.status, 200); assert.equal((await response.json()).outcomes[0].error, 'destination_invalid'); assert.equal(bulk.calls.length, 0);
  const f = fixture('ownerIssueConversionCredential', () => assert.fail('No credential-bearing label may reach SQL.'));
  await error(await f.handler(request('/conversion-credentials/issue', { ...issueBody(), label: ingest })), 400, 'invalid_request');
  const disclosure = fixture('conversionIngest', () => ({ ...ack(), acceptedAt: ingest }));
  await error(await disclosure.handler(request('/conversions/ingest', event(), { authorization: ingest, suppliedOrigin: null })), 503, 'service_unavailable');
});

test('bulk normalizes every valid row and merges invalid draft outcomes only after the repository settles', async () => {
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const f = fixture('ownerBulkCreateLinks', async (_digest, payload) => { await barrier; return { outcomes: payload.rows.map(committed) }; });
  const valid = bulkRow(1), invalid = bulkRow(2); invalid.draft.destination = 'http://127.0.0.1/private';
  let settled = false;
  const waiting = f.handler(request('/links/bulk-create', { workspaceId: ids.workspaceId, rows: [invalid, valid] })).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.equal(f.calls.length, 1);
  const payload = f.calls[0][1]; assert.deepEqual(Object.keys(payload).sort(), ['rows', 'workspaceId']); assert.equal(payload.rows.length, 1);
  assert.equal(payload.rows[0].sourceIndex, 1); assert.equal(payload.rows[0].destination, 'https://example.com/guide?retained=%2f&utm_source=review&utm_medium=share&utm_campaign=authored#part');
  assert.equal(payload.rows[0].safety.reputation, 'unchecked'); assert.equal(Object.hasOwn(payload.rows[0], 'draft'), false);
  release(); const response = await waiting; assert.equal(response.status, 200); const output = await response.json();
  assert.deepEqual(output.outcomes.map(row => [row.sourceIndex, row.status, row.error]), [[0, 'error', 'destination_invalid'], [1, 'committed', null]]);
  assert.equal(output.outcomes[0].mutationKey, invalid.mutationKey); assert.equal(output.outcomes[1].mutationKey, valid.mutationKey);
});

test('bulk rejects duplicate stable keys resources slugs and invalid row envelopes before any mutation', async () => {
  const f = fixture('ownerBulkCreateLinks', () => assert.fail('Batch identities must be checked before writes.'));
  for (const field of ['mutationKey', 'linkId', 'revisionId', 'slug']) {
    const first = bulkRow(1), second = bulkRow(2); second[field] = first[field];
    await error(await f.handler(request('/links/bulk-create', { workspaceId: ids.workspaceId, rows: [first, second] })), 409, 'conflict');
  }
  for (const rows of [[], Array.from({ length: 51 }, (_, index) => bulkRow(index)), [{ ...bulkRow(1), sourceIndex: 0 }], [{ ...bulkRow(1), mutationKey: 'invalid' }]]) {
    await error(await f.handler(request('/links/bulk-create', { workspaceId: ids.workspaceId, rows })), 400, 'invalid_request');
  }
  assert.equal(f.calls.length, 0);
});

test('all-invalid drafts report local row refusals while actual body limits still cap small batches', async () => {
  let repositories = 0;
  const handler = createHandler({ origin, repository: async () => { repositories++; assert.fail('Invalid drafts do not open a database connection.'); } });
  const rows = [bulkRow(1), bulkRow(2)]; rows[0].draft.destination = 'javascript:alert(1)'; rows[1].draft.extra = true;
  const response = await handler(request('/links/bulk-create', { workspaceId: ids.workspaceId, rows }));
  assert.equal(response.status, 200); assert.equal((await response.json()).outcomes.length, 2); assert.equal(repositories, 0);
  await error(await handler(request('/links/bulk-create', {}, { raw: ' '.repeat(32769) })), 413, 'request_too_large');
  assert.equal(repositories, 0);
});

test('native bulk errors are finite row outcomes while incomplete or forged commit receipts fail closed', async () => {
  const row = bulkRow(1), input = { workspaceId: ids.workspaceId, rows: [row] };
  let mode = 'denied';
  const f = fixture('ownerBulkCreateLinks', (_digest, payload) => {
    const result = committed(payload.rows[0]);
    if (mode === 'denied') return { outcomes: [{ ...result, status: 'error', version: null, error: 'linky_conflict' }] };
    if (mode === 'unavailable') return { outcomes: [{ ...result, status: 'error', version: null, error: 'linky_unavailable' }] };
    if (mode === 'forged') return { outcomes: [{ ...result, linkId: uuid(99) }] };
    if (mode === 'unknown') return { outcomes: [{ ...result, status: 'error', version: null, error: ingest }] };
    return { outcomes: [] };
  });
  assert.equal((await (await f.handler(request('/links/bulk-create', input))).json()).outcomes[0].error, 'conflict');
  mode = 'unavailable'; assert.equal((await (await f.handler(request('/links/bulk-create', input))).json()).outcomes[0].error, 'service_unavailable');
  for (mode of ['forged', 'unknown', 'incomplete']) await error(await f.handler(request('/links/bulk-create', input)), 503, 'service_unavailable');
  assert.equal(f.calls.length, 5);
});

test('conversion acknowledgment is withheld until the committed repository result and scope must match', async () => {
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const f = fixture('conversionIngest', async () => { await barrier; return ack(); });
  let settled = false;
  const pending = f.handler(request('/conversions/ingest', event(), { authorization: ingest, suppliedOrigin: null })).then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.equal(f.calls.length, 1);
  release(); assert.deepEqual(await (await pending).json(), ack());
  const wrong = fixture('conversionIngest', () => ({ ...ack(), eventKey: uuid(99) }));
  await error(await wrong.handler(request('/conversions/ingest', event(), { authorization: ingest, suppliedOrigin: null })), 503, 'service_unavailable');
  const uncertain = fixture('conversionIngest', () => { throw new Error('Authored uncertain database outcome'); });
  await error(await uncertain.handler(request('/conversions/ingest', event(), { authorization: ingest, suppliedOrigin: null })), 503, 'service_unavailable');
  assert.equal(uncertain.calls.length, 1);
});

test('attribution preserves bounded separate cohorts unknown sales and exact per-currency integer strings', async () => {
  const f = fixture('ownerAttributionReport', report);
  const response = await f.handler(request('/reports/attribution', { workspaceId: ids.workspaceId, from: null, to: null, limit: 50 }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ...report(), conversionsAvailable: true });
  assert.deepEqual(f.calls[0][1], { workspaceId: ids.workspaceId, from: null, to: null, limit: 50 });
  assert.equal(report().declarations.currencies[0].amountMinor, '18014398509481982');
  assert.equal(report().declarations.currencies[1].amountMinor, '0');
});

test('attribution rejects invented totals unsafe numeric money or secret-bearing report extensions', async () => {
  let output;
  const f = fixture('ownerAttributionReport', () => output);
  const input = { workspaceId: ids.workspaceId, from: null, to: null, limit: 50 };
  for (const mutate of [value => { value.declarations.total++; }, value => { value.declarations.currencies[0].amountMinor = 18014398509481982; },
    value => { value.declarations.currencies.push({ ...value.declarations.currencies[1] }); }, value => { value.declarations.coverage.limit = 5000; },
    value => { value.declarations.credentialHash = 'a'.repeat(64); }, value => { value.redemptions.campaigns[0].campaign.source = ingest; }]) {
    output = report(); mutate(output); await error(await f.handler(request('/reports/attribution', input)), 503, 'service_unavailable');
  }
});

test('new routes remain closed and public availability does not claim configured database health', async () => {
  const handler = createHandler();
  const response = await handler(request('/status', undefined, { method: 'GET', authorization: null }));
  assert.deepEqual(await response.json(), { service: 'linky', configuration: 'required', database: 'unverified', conversionsAvailable: true });
  for (const route of ['links/bulk-create', 'conversion-credentials/issue', 'conversion-credentials/list', 'conversion-credentials/revoke', 'conversions/ingest', 'reports/attribution']) {
    assert(API_ROUTES.includes(route));
    await error(await handler(request('/' + route, undefined, { method: 'GET', authorization: null })), 405, 'method_not_allowed');
  }
  assert.equal(API_ROUTES.includes('conversions/execute'), false);
});
