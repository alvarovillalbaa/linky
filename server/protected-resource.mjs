// Copy/import this dependency-free guard into the server that owns the bytes.
// Configuration is trusted server state, never supplied by a visiting client.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ORIGIN_KEY = /^lyp_[0-9a-f]{64}$/u, ACCESS_KEY = /^lya_[0-9a-f]{64}$/u;
const FIELDS = ['authorized', 'credentialId', 'accessId', 'receiptId', 'linkId', 'revisionId', 'resourceUrl', 'expiresAt'];

function secureURL(value) {
  const url = new URL(value);
  if (typeof value !== 'string' || value.length > 2048 || url.href !== value || url.protocol !== 'https:' || url.username || url.password || url.hash) throw new TypeError('Invalid protected resource configuration');
  return url;
}

export function createProtectedResource({ linkyOrigin, credentialId, originKey, resourceUrl, fetchImpl = globalThis.fetch } = {}, handler) {
  const api = secureURL(`${linkyOrigin}/`), resource = secureURL(resourceUrl);
  if (api.origin !== linkyOrigin || api.pathname !== '/' || api.search || !UUID.test(credentialId) || !ORIGIN_KEY.test(originKey) || typeof fetchImpl !== 'function' || typeof handler !== 'function') throw new TypeError('Invalid protected resource configuration');
  const allowedOrigins = new Set([linkyOrigin, resource.origin]);

  return async request => {
    const origin = request.headers.get('origin');
    const headers = new Headers({ 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', vary: 'Origin, Authorization, X-Linky-Access-Id' });
    if (origin && allowedOrigins.has(origin)) headers.set('access-control-allow-origin', origin);
    const refuse = (code, status) => {
      headers.set('content-type', 'application/json; charset=utf-8');
      return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error: { code } }), { status, headers });
    };
    if (request.url !== resourceUrl) return refuse('resource_not_found', 404);
    if ((origin && !allowedOrigins.has(origin)) || request.headers.has('cookie')) return refuse('access_denied', 403);
    if (request.method === 'OPTIONS') {
      const method = request.headers.get('access-control-request-method');
      const requested = (request.headers.get('access-control-request-headers') ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (!origin || !['GET', 'HEAD'].includes(method) || requested.length !== new Set(requested).size
        || requested.some(name => !['authorization', 'x-linky-access-id'].includes(name))) return refuse('preflight_denied', 403);
      headers.set('access-control-allow-methods', 'GET, HEAD');
      headers.set('access-control-allow-headers', 'Authorization, X-Linky-Access-Id');
      return new Response(null, { status: 204, headers });
    }
    if (!['GET', 'HEAD'].includes(request.method)) { headers.set('allow', 'GET, HEAD, OPTIONS'); return refuse('method_not_allowed', 405); }
    const authorization = request.headers.get('authorization'), accessId = request.headers.get('x-linky-access-id');
    if (!authorization?.startsWith('Bearer ') || !ACCESS_KEY.test(authorization.slice(7)) || !UUID.test(accessId)) return refuse('access_required', 401);
    const accessKey = authorization.slice(7), controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    let reader, timer;
    const expired = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Authorization timeout')); }, 3000); });
    const bounded = promise => Promise.race([promise, expired]);
    try {
      const reply = await bounded(fetchImpl(`${linkyOrigin}/api/v1/origin/authorize`, {
        method: 'POST', headers: { Authorization: `Bearer ${originKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ credentialId, accessId, accessKey }), credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
      }));
      if (!reply.ok || reply.redirected || !reply.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('Authorization refused');
      const length = reply.headers.get('content-length');
      if (length && (!/^[0-9]+$/u.test(length) || Number(length) > 8192)) throw new Error('Invalid authorization reply');
      reader = reply.body?.getReader(); if (!reader) throw new Error('Missing authorization reply');
      const chunks = []; let total = 0;
      for (;;) {
        const { done, value } = await bounded(reader.read()); if (done) break;
        total += value.byteLength; if (total > 8192) throw new Error('Oversized authorization reply'); chunks.push(value);
      }
      const buffer = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
      const decision = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
      if (!decision || Array.isArray(decision) || Object.keys(decision).length !== FIELDS.length || FIELDS.some(key => !Object.hasOwn(decision, key))
        || decision.authorized !== true || decision.credentialId !== credentialId || decision.accessId !== accessId || decision.resourceUrl !== resourceUrl
        || !['receiptId', 'linkId', 'revisionId'].every(key => UUID.test(decision[key]))
        || typeof decision.expiresAt !== 'string' || !Number.isFinite(Date.parse(decision.expiresAt)) || Date.parse(decision.expiresAt) <= Date.now()) throw new Error('Invalid authorization decision');
    } catch {
      return refuse('resource_access_unavailable', 403);
    } finally {
      clearTimeout(timer); controller.abort(); request.signal.removeEventListener('abort', abort);
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    // Credentials stop here, before resource handlers or their downstream logs.
    const safeHeaders = new Headers();
    for (const key of ['accept', 'range', 'if-range']) if (request.headers.has(key)) safeHeaders.set(key, request.headers.get(key));
    try {
      const result = await handler(new Request(resourceUrl, { method: request.method, headers: safeHeaders, signal: request.signal }));
      if (!(result instanceof Response) || (result.status >= 300 && result.status < 400)) {
        if (result instanceof Response) void result.body?.cancel().catch(() => {});
        return refuse('resource_handler_unavailable', 502);
      }
      const outgoing = new Headers(result.headers);
      for (const name of [...outgoing.keys()]) if (name.startsWith('access-control-')) outgoing.delete(name);
      for (const name of ['set-cookie', 'location', 'etag', 'last-modified', 'expires', 'surrogate-control', 'cdn-cache-control']) outgoing.delete(name);
      for (const [name, value] of headers) outgoing.set(name, value);
      if (request.method === 'HEAD') void result.body?.cancel().catch(() => {});
      return new Response(request.method === 'HEAD' ? null : result.body, { status: result.status, headers: outgoing });
    } catch { return refuse('resource_handler_unavailable', 502); }
  };
}
