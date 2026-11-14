import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHandler, API_ROUTES } from '../../server/http.mjs';
import { createProtectedResource } from '../../server/protected-resource.mjs';
import { generateCapability, hashCapability } from '../../server/capabilities.mjs';
import { downloadProtectedResource, RESOURCE_DOWNLOAD_LIMIT } from '../../public/src/resource-client.mjs';

const origin = 'https://linky.example.com', resourceUrl = 'https://resource.example.com/private.bin?scope=authored';
const owner = generateCapability('owner'), recipient = generateCapability('recipient'), originKey = generateCapability('origin'), accessKey = generateCapability('access');
const workspaceId = randomUUID(), linkId = randomUUID(), revisionId = randomUUID(), grantId = randomUUID(), receiptId = randomUUID(), credentialId = randomUUID(), accessId = randomUUID();
const expiresAt = '2099-01-01T00:00:00.000Z';
const decision = () => ({ authorized: true, credentialId, accessId, receiptId, linkId, revisionId, resourceUrl, expiresAt });
const authBody = { credentialId, accessId, accessKey };
const request = (route, payload, options = {}) => new Request(origin + '/api/v1/' + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(!options.server ? { origin } : {}), ...(options.key ? { authorization: 'Bearer ' + options.key } : {}), ...options.headers }, body: JSON.stringify(payload) });
const json = value => Response.json(value);
const visitor = (options = {}) => new Request(options.url ?? resourceUrl, { method: options.method ?? 'GET', headers: { authorization: 'Bearer ' + accessKey, 'x-linky-access-id': accessId, ...options.headers } });
function guard(fetchImpl = async () => json(decision()), handler = async () => new Response('authored private bytes')) {
  return createProtectedResource({ linkyOrigin: origin, credentialId, originKey, resourceUrl, fetchImpl }, handler);
}

test('P01 capabilities have disjoint origin/access purposes', () => {
  for (const [key, purpose] of [[originKey, 'origin'], [accessKey, 'access']]) {
    assert.match(hashCapability(key, purpose), /^[a-f0-9]{64}$/u);
    for (const other of ['owner', 'recipient', 'ingest', purpose === 'origin' ? 'access' : 'origin']) assert.throws(() => hashCapability(key, other));
  }
});
test('P02 origin authorization hashes both keys and closes the route inventory', async () => {
  assert(API_ROUTES.includes('origin/authorize')); let calls = 0;
  const app = createHandler({ origin, repository: { originAuthorize: async (digest, payload) => {
    calls++; assert.equal(digest, hashCapability(originKey, 'origin'));
    assert.deepEqual(payload, { credentialId, accessId, accessHash: hashCapability(accessKey, 'access') }); return decision();
  } } });
  assert.equal((await app(request('origin/authorize', authBody, { key: originKey, server: true }))).status, 200);
  assert.equal((await app(request('origin/authorize/unknown', authBody, { key: originKey, server: true }))).status, 404); assert.equal(calls, 1);
});
test('P03 origin route refuses cookies, cross-site Origin and non-origin authority before SQL', async () => {
  let calls = 0; const app = createHandler({ origin, repository: { originAuthorize: () => { calls++; return decision(); } } });
  for (const options of [{ key: owner, server: true }, { key: originKey, server: true, headers: { cookie: 'ambient=1' } }, { key: originKey, headers: { origin: 'https://elsewhere.example.com' } }, { key: originKey, server: true, headers: { 'sec-fetch-site': 'cross-site' } }]) assert.notEqual((await app(request('origin/authorize', authBody, options))).status, 200);
  assert.equal(calls, 0);
});
test('P04 recipient preparation requires body-only recipient authority and exact fields', async () => {
  let calls = 0;
  const app = createHandler({ origin, repository: { recipientPrepareResourceAccess: async (digest, payload) => {
    calls++; assert.equal(digest, hashCapability(recipient, 'recipient')); assert.equal(payload.accessHash, hashCapability(accessKey, 'access'));
    return { grantId, receiptId, linkId, revisionId, resourceUrl, expiresAt, accessId, version: 1, replayed: false };
  } } });
  const payload = { grantId, recipientKey: recipient, receiptId, accessId, accessKey, expectedAccessVersion: 0 };
  assert.equal((await app(request('recipient/resource-prepare', payload))).status, 200);
  for (const [input, status] of [[{ ...payload, expectedAccessVersion: -1 }, 400], [{ ...payload, expectedAccessVersion: '0' }, 400], [{ ...payload, extra: true }, 400], [{ ...payload, accessKey: recipient }, 401]]) assert.equal((await app(request('recipient/resource-prepare', input))).status, status);
  assert.equal((await app(request('recipient/resource-prepare', payload, { key: owner }))).status, 401); assert.equal(calls, 1);
});
test('P05 owner origin issue confirms only scoped non-secret metadata', async () => {
  const payload = { workspaceId, linkId, revisionId, mutationKey: randomUUID(), expectedVersion: 1, credentialId, originKey, label: 'Authored host', expiresAt };
  const app = createHandler({ origin, repository: { ownerIssueOriginCredential: async (digest, input) => {
    assert.equal(digest, hashCapability(owner, 'owner')); assert.equal(input.originHash, hashCapability(originKey, 'origin')); assert(!Object.hasOwn(input, 'originKey'));
    return { workspaceId, linkId, revisionId, credentialId, resourceUrl, version: 2, replayed: false };
  } } });
  const reply = await app(request('origin-credentials/issue', payload, { key: owner }));
  assert.equal(reply.status, 200); const value = await reply.json(); assert.equal(value.mutationKey, payload.mutationKey); assert(!JSON.stringify(value).includes(originKey));
});
for (const [name, change] of [['wrong access', value => ({ ...value, accessId: randomUUID() })], ['false authorization', value => ({ ...value, authorized: false })], ['extra secret', value => ({ ...value, originKey })], ['unsafe target', value => ({ ...value, resourceUrl: 'http://resource.example.com/private.bin' })], ['bad expiry', value => ({ ...value, expiresAt: 'never' })]]) {
  test('P06 response guard refuses ' + name, async () => {
    const app = createHandler({ origin, repository: { originAuthorize: async () => change(decision()) } });
    assert.equal((await app(request('origin/authorize', authBody, { key: originKey, server: true }))).status, 503);
  });
}
test('P07 newly reserved keys cannot enter old metadata paths', async () => {
  let calls = 0; const app = createHandler({ origin, repository: { ownerListLinks: () => { calls++; } } });
  for (const search of [originKey, accessKey]) assert.equal((await app(request('links/list', { workspaceId, limit: 50, after: null, state: 'all', search }, { key: owner }))).status, 400);
  assert.equal(calls, 0);
});
test('P08 host checks each GET/HEAD, forwards only purpose-bound access, sanitizes handler and disables caches', async () => {
  let checks = 0, handlers = 0;
  const wrapped = guard(async (url, options) => {
    checks++; assert.equal(url, origin + '/api/v1/origin/authorize'); assert.equal(options.headers.Authorization, 'Bearer ' + originKey);
    assert.deepEqual(JSON.parse(options.body), authBody); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    return json(decision());
  }, async input => {
    handlers++; assert(!input.headers.has('authorization')); assert(!input.headers.has('x-linky-access-id')); assert(!input.headers.has('cookie'));
    return new Response('authored bytes', { headers: { 'cache-control': 'public, max-age=3600', 'set-cookie': 'bad=1', location: 'https://elsewhere.example.com', 'access-control-allow-origin': '*' } });
  });
  for (const method of ['GET', 'GET', 'HEAD']) {
    const reply = await wrapped(visitor({ method, headers: { origin } })); assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('cache-control'), 'private, no-store'); assert.equal(reply.headers.get('access-control-allow-origin'), origin);
    assert(!reply.headers.has('set-cookie')); assert(!reply.headers.has('location')); assert.equal(await reply.text(), method === 'HEAD' ? '' : 'authored bytes');
  }
  assert.equal(checks, 3); assert.equal(handlers, 3);
});
test('P09 preflight is explicit and never authorizes or serves bytes', async () => {
  let checks = 0; const wrapped = guard(() => { checks++; throw new Error(); });
  const preflight = headers => wrapped(new Request(resourceUrl, { method: 'OPTIONS', headers }));
  const reply = await preflight({ origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,x-linky-access-id' });
  assert.equal(reply.status, 204); assert(!reply.headers.has('access-control-allow-credentials'));
  assert.equal((await preflight({ origin: 'https://other.example.com', 'access-control-request-method': 'GET' })).status, 403);
  assert.equal((await preflight({ origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'cookie' })).status, 403); assert.equal(checks, 0);
});
test('P10 exact resource, method and ambient-authority refusals happen before authorization', async () => {
  let checks = 0; const wrapped = guard(() => { checks++; throw new Error(); });
  for (const input of [{ url: resourceUrl + '&extra=1' }, { method: 'POST' }, { headers: { cookie: 'ambient=1' } }, { headers: { authorization: 'Bearer ' + recipient } }, { headers: { origin: 'https://other.example.com' } }]) assert.notEqual((await wrapped(visitor(input))).status, 200);
  assert.equal(checks, 0);
});
for (const [name, reply] of [['unavailable', () => { throw new Error(); }], ['revoked', () => new Response('', { status: 410 })], ['malformed', () => new Response('{', { headers: { 'content-type': 'application/json' } })], ['wrong scope', () => json({ ...decision(), resourceUrl: resourceUrl + '&other=1' })], ['expired', () => json({ ...decision(), expiresAt: '2000-01-01T00:00:00.000Z' })], ['oversized', () => new Response(' '.repeat(8193), { headers: { 'content-type': 'application/json' } })]]) {
  test('P11 host fails closed for ' + name, async () => {
    let served = false; const wrapped = guard(reply, () => { served = true; return new Response('private'); });
    assert.equal((await wrapped(visitor())).status, 403); assert.equal(served, false);
  });
}
test('P12 authorized handler cannot redirect to an unguarded target', async () => {
  assert.equal((await guard(undefined, () => Response.redirect('https://elsewhere.example.com'))(visitor())).status, 502);
});
test('P13 guard refuses insecure or unscoped server configuration', () => {
  for (const change of [{ linkyOrigin: 'http://linky.example.com' }, { linkyOrigin: origin + '/path' }, { resourceUrl: resourceUrl + '#fragment' }, { originKey: recipient }]) assert.throws(() => createProtectedResource({ linkyOrigin: origin, credentialId, originKey, resourceUrl, ...change }, () => new Response('')));
});
test('P14 downloader uses resource authority only and produces an inert attachment', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, resourceUrl); assert.equal(options.headers.Authorization, 'Bearer ' + accessKey); assert.equal(options.headers['X-Linky-Access-Id'], accessId);
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert(!JSON.stringify(options).includes(recipient));
      return new Response('<script>authored</script>', { headers: { 'content-type': 'text/html' } });
    };
    const blob = await downloadProtectedResource({ resourceUrl, accessId, accessKey }); assert.equal(blob.type, 'application/octet-stream'); assert.equal(await blob.text(), '<script>authored</script>');
  } finally { globalThis.fetch = previous; }
});
test('P15 downloader refuses oversized decoded bodies and refused responses', async () => {
  const previous = globalThis.fetch;
  try {
    for (const reply of [() => new Response('', { status: 403 }), () => new Response('', { headers: { 'content-length': String(RESOURCE_DOWNLOAD_LIMIT + 1) } }), () => new Response(new Uint8Array(RESOURCE_DOWNLOAD_LIMIT + 1))]) {
      globalThis.fetch = async () => reply(); await assert.rejects(() => downloadProtectedResource({ resourceUrl, accessId, accessKey }));
    }
  } finally { globalThis.fetch = previous; }
});
test('P16 guard bounds a stalled authorization header response', { timeout: 5000 }, async () => {
  let served = false; const start = Date.now(); const wrapped = guard(() => new Promise(() => {}), () => { served = true; return new Response('private'); });
  assert.equal((await wrapped(visitor())).status, 403); assert.equal(served, false); assert(Date.now() - start < 4500);
});
test('P17 guard bounds a stalled authorization body', { timeout: 5000 }, async () => {
  const start = Date.now(), wrapped = guard(() => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }));
  assert.equal((await wrapped(visitor())).status, 403); assert(Date.now() - start < 4500);
});
test('P18 downloader bounds a stalled decoded response body', { timeout: 12000 }, async () => {
  const previous = globalThis.fetch, start = Date.now();
  try { globalThis.fetch = async () => new Response(new ReadableStream({ start() {} })); await assert.rejects(() => downloadProtectedResource({ resourceUrl, accessId, accessKey }), error => error.code === 'resource_timeout'); assert(Date.now() - start < 11500); }
  finally { globalThis.fetch = previous; }
});
