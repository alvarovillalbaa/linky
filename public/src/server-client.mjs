// Credentials belong to the caller's tab memory, never this transport.
export class ServiceError extends Error {
  constructor(code, { uncertain = false, status = 0 } = {}) {
    super(code); this.name = 'ServiceError'; this.code = code;
    this.uncertain = uncertain; this.status = status;
  }
}

export async function requestService(path, { method = 'POST', credential = '', body, signal } = {}) {
  if (typeof path !== 'string' || !/^\/api\/v1\/[a-zA-Z0-9/_-]+$/.test(path)
    || !['GET', 'POST'].includes(method)) throw new ServiceError('request_invalid');
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 15_000);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let reader;
  try {
    const headers = { Accept: 'application/json' };
    if (credential) headers.Authorization = `Bearer ${credential}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      mode: 'same-origin', credentials: 'omit', redirect: 'error', cache: 'no-store',
      referrerPolicy: 'no-referrer', signal: controller.signal,
    });
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new ServiceError('response_invalid', { uncertain: method !== 'GET', status: response.status });
    }
    reader = response.body?.getReader();
    if (!reader) throw new ServiceError('response_invalid', { uncertain: method !== 'GET' });
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_048_576) { controller.abort(); throw new ServiceError('response_too_large', { uncertain: method !== 'GET' }); }
      chunks.push(value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
    catch { throw new ServiceError('response_invalid', { uncertain: method !== 'GET', status: response.status }); }
    if (!response.ok) {
      const raw = value?.error?.code;
      const code = typeof raw === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(raw) ? raw : 'service_unavailable';
      throw new ServiceError(code, { uncertain: method !== 'GET' && response.status >= 500, status: response.status });
    }
    return value;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('connection_unavailable', { uncertain: method !== 'GET' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (reader) { try { await reader.cancel(); } catch { /* Request already settled. */ } reader.releaseLock(); }
  }
}
