// Runnable HTTPS private-file server. No dependency, public static route or key log.
import { createServer } from 'node:https';
import { readFileSync, createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createProtectedResource } from '../../server/protected-resource.mjs';

const { LINKY_ORIGIN, LINKY_ORIGIN_CREDENTIAL_ID, LINKY_ORIGIN_KEY, LINKY_RESOURCE_URL,
  LINKY_PRIVATE_FILE, LINKY_TLS_CERT_FILE, LINKY_TLS_KEY_FILE } = process.env;
const target = new URL(LINKY_RESOURCE_URL);
const file = statSync(LINKY_PRIVATE_FILE);
if (!file.isFile() || target.port) throw new Error('Configure an existing private file and a default-port HTTPS resource URL');
const guarded = createProtectedResource({ linkyOrigin: LINKY_ORIGIN, credentialId: LINKY_ORIGIN_CREDENTIAL_ID, originKey: LINKY_ORIGIN_KEY, resourceUrl: LINKY_RESOURCE_URL }, request => new Response(
  request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(LINKY_PRIVATE_FILE)),
  { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="protected-resource.bin"', 'content-length': String(file.size) } },
));
const server = createServer({ cert: readFileSync(LINKY_TLS_CERT_FILE), key: readFileSync(LINKY_TLS_KEY_FILE) }, async (incoming, outgoing) => {
  try {
    if (incoming.headers.host !== target.host) { outgoing.writeHead(421); outgoing.end(); return; }
    const url = new URL(incoming.url, target.origin);
    const controller = new AbortController(); outgoing.on('close', () => controller.abort());
    const response = await guarded(new Request(url.href, { method: incoming.method, headers: incoming.headers, signal: controller.signal }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).on('error', () => outgoing.destroy()).pipe(outgoing); else outgoing.end();
  } catch { outgoing.writeHead(503, { 'cache-control': 'no-store' }); outgoing.end(); }
});
server.requestTimeout = 10_000; server.headersTimeout = 5000; server.maxHeadersCount = 50;
server.listen(443, '0.0.0.0');
