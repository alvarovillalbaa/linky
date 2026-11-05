// Disposable CI/local HTTP adapter. Production uses the Vercel entry point.
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../server/http.mjs';

const publicRoot = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const staticHeaders = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

export async function startServer({ repository, port = 0, host = '127.0.0.1' } = {}) {
  if (host !== '127.0.0.1') throw new Error('The development adapter binds only to loopback.');
  let handler;
  const server = createServer(async (request, response) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const url = new URL(request.url, origin);
      if (url.pathname.startsWith('/api/')) {
        const chunks = []; let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 65536) { response.writeHead(413, staticHeaders); response.end(); return; }
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        const input = new Request(url, { method: request.method, headers: request.headers,
          ...(['GET', 'HEAD'].includes(request.method) ? {} : { body, duplex: 'half' }) });
        const output = await handler(input);
        response.writeHead(output.status, Object.fromEntries(output.headers));
        response.end(request.method === 'HEAD' ? undefined : Buffer.from(await output.arrayBuffer()));
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, staticHeaders); response.end(); return; }
      const route = url.pathname === '/' || /^\/r\/[0-9a-f-]{36}$/u.test(url.pathname) ? '/index.html' : decodeURIComponent(url.pathname);
      const candidate = resolve(publicRoot, `.${route}`);
      if (!candidate.startsWith(`${publicRoot}${sep}`)) throw new Error('not_found');
      const actual = await realpath(candidate);
      if (!actual.startsWith(`${publicRoot}${sep}`)) throw new Error('not_found');
      const content = await readFile(actual);
      response.writeHead(200, { ...staticHeaders, 'Content-Type': types[extname(actual)] ?? 'application/octet-stream' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      if (!response.headersSent) response.writeHead(404, staticHeaders);
      response.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, host, accept); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createHandler({ repository, origin, allowInsecureLoopback: true });
  return {
    origin,
    async close() { await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())); },
  };
}
