import { ServiceError } from './server-client.mjs';

export const RESOURCE_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
export async function downloadProtectedResource({ resourceUrl, accessId, accessKey, signal }) {
  let target;
  try { target = new URL(resourceUrl); } catch { throw new ServiceError('resource_invalid'); }
  if (target.href !== resourceUrl || target.protocol !== 'https:' || target.hash || target.username || target.password
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(accessId)
    || !/^lya_[0-9a-f]{64}$/u.test(accessKey)) throw new ServiceError('resource_invalid');
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  let timer, reader;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ServiceError('resource_timeout')); }, 10_000); });
  const bounded = value => Promise.race([value, expired]);
  try {
    const response = await bounded(fetch(resourceUrl, { headers: { Authorization: `Bearer ${accessKey}`, 'X-Linky-Access-Id': accessId },
      credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal }));
    if (response.status !== 200 || response.redirected || response.type === 'opaque') throw new ServiceError('resource_refused');
    const length = response.headers.get('content-length');
    if (length && (!/^[0-9]+$/u.test(length) || Number(length) > RESOURCE_DOWNLOAD_LIMIT)) throw new ServiceError('resource_too_large');
    reader = response.body?.getReader(); if (!reader) throw new ServiceError('resource_invalid');
    const chunks = []; let bytes = 0;
    for (;;) {
      const { done, value } = await bounded(reader.read()); if (done) break;
      bytes += value.byteLength; if (bytes > RESOURCE_DOWNLOAD_LIMIT) throw new ServiceError('resource_too_large'); chunks.push(value);
    }
    // Always an inert attachment, regardless of an origin's HTML/SVG MIME type.
    return new Blob(chunks, { type: 'application/octet-stream' });
  } catch (error) { if (error instanceof ServiceError) throw error; throw new ServiceError('resource_unavailable'); }
  finally {
    clearTimeout(timer); controller.abort(); signal?.removeEventListener('abort', abort);
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
