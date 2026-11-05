import { createHandler, API_ROUTES } from '../server/http.mjs';
import { createPostgresRepository } from '../server/postgres.mjs';
import { LinkyError, publicError } from '../server/errors.mjs';

let repository;
const getRepository = () => repository ??= createPostgresRepository({ connectionString: process.env.LINKY_DATABASE_URL,
  ...(process.env.LINKY_PG_CA ? { ca: process.env.LINKY_PG_CA } : {}) }).catch(error => { repository = null; throw error; });

function readBody(request) {
  // Vercel's public Node helpers restore raw data/end events after buffering.
  // Never consume their parsed req.body: strict UTF-8 belongs to our handler.
  return new Promise((resolve, reject) => {
    let finished = false, bytes = 0;
    const chunks = [], deadline = Date.now() + 5000;
    const finish = (error) => {
      if (finished) return; finished = true; clearTimeout(timer);
      for (const [event, listener] of [['data', data], ['end', end], ['error', failed], ['aborted', aborted]]) request.removeListener(event, listener);
      if (error) { request.pause(); reject(error); } else resolve(Buffer.concat(chunks));
    };
    const data = chunk => {
      if (finished) return;
      if (Date.now() > deadline) { finish(new LinkyError('request_timeout', 408)); return; }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > 32 * 1024) { finish(new LinkyError('request_too_large', 413)); return; }
      chunks.push(buffer);
    };
    const end = () => finish(Date.now() > deadline ? new LinkyError('request_timeout', 408) : null);
    const failed = () => finish(new LinkyError('invalid_request'));
    const aborted = () => finish(new LinkyError('invalid_request'));
    const timer = setTimeout(() => finish(new LinkyError('request_timeout', 408)), 5000);
    request.on('error', failed); request.on('aborted', aborted); request.on('end', end); request.on('data', data);
  });
}

export default async function handler(request, result) {
  const head = request.method === 'HEAD';
  try {
    const origin = process.env.LINKY_PUBLIC_ORIGIN;
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
    const path = new URL(request.url, 'https://linky.invalid');
    // A fixed rewrite carries only a closed route name, never credentials/data.
    const routes = path.searchParams.getAll('linky_route');
    // Temporary redacted probe for the public, inert status route only.
    if (request.method === 'GET' && (routes.includes('status') || path.pathname === '/api/v1/status')) {
      const sourcePath = path.searchParams.getAll('path');
      console.info('LINKY_PUBLIC_ROUTE_PROBE=' + JSON.stringify({
        pathKind: ['/api/v1', '/api/v1/status', '/api/v1.mjs'].includes(path.pathname) ? path.pathname : 'other',
        routeHintCount: routes.length, allHintsStatus: routes.every(value => value === 'status'),
        sourcePathCount: sourcePath.length, allSourcePathsStatus: sourcePath.every(value => value === 'status'),
        otherQueryCount: [...path.searchParams.keys()].filter(key => !['linky_route', 'path'].includes(key)).length,
      }));
    }
    if (routes.length > 1 || (routes.length && (!API_ROUTES.includes(routes[0])
      || (path.pathname !== '/api/v1' && path.pathname !== `/api/v1/${routes[0]}`)))) throw new LinkyError('invalid_request');
    path.searchParams.delete('linky_route');
    const pathname = routes.length ? `/api/v1/${routes[0]}` : path.pathname;
    const url = `${origin || 'https://linky.invalid'}${pathname}${path.search}`;
    const payload = !['GET', 'HEAD'].includes(request.method) ? await readBody(request) : undefined;
    const web = new Request(url, { method: request.method, headers, ...(payload !== undefined ? { body: payload } : {}) });
    const response = await createHandler({ repository: process.env.LINKY_DATABASE_URL ? getRepository : null, origin })(web);
    result.writeHead(response.status, Object.fromEntries(response.headers));
    result.end(head ? undefined : Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    const safe = publicError(error);
    result.writeHead(safe.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
    result.end(head ? undefined : JSON.stringify({ error: { code: safe.code } }));
  }
}
