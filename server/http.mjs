import { buildDestination, analyzeDestination, DestinationError } from '../public/src/destinations.mjs';
import { hashCapability, ownerDigest, headerDigest } from './capabilities.mjs';
import { LinkyError, publicError } from './errors.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BODY_LIMIT = 32 * 1024;
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new LinkyError('invalid_request');
  return value;
}
function id(value) { if (typeof value !== 'string' || !UUID.test(value)) throw new LinkyError('invalid_request'); return value.toLowerCase(); }
function number(value, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new LinkyError('invalid_request'); return value;
}
function label(value, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u001f\u007f]/u.test(value)
    || /ly[ori]_[0-9a-f]{64}/u.test(value) || !value.isWellFormed()) throw new LinkyError('invalid_request'); return value;
}
function instant(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-/u.test(value)) throw new LinkyError('invalid_request');
  let normalized; try { normalized = new Date(value).toISOString(); } catch { throw new LinkyError('invalid_request'); }
  if (normalized !== value || value.startsWith('0000')) throw new LinkyError('invalid_request'); return value;
}
function state(value, all = false) {
  if (!['active', 'paused', 'blocked', ...(all ? ['all'] : [])].includes(value)) throw new LinkyError('invalid_request');
  return value === 'all' ? null : value;
}
function scope(body) { return { workspaceId: id(body.workspaceId) }; }
function mutation(body) { return { ...scope(body), mutationKey: id(body.mutationKey) }; }
function destination(draft) {
  let built, checked;
  try { built = buildDestination(draft); checked = analyzeDestination(built.url); }
  catch (error) { if (error instanceof DestinationError) throw new LinkyError('destination_invalid'); throw error; }
  for (const value of [built.url, ...Object.values(built.draft)]) if (/ly[ori]_[0-9a-f]{64}/u.test(value)) throw new LinkyError('destination_invalid');
  return { label: built.draft.title, destination: built.url,
    campaign: { source: built.draft.source, medium: built.draft.medium, campaign: built.draft.campaign },
    safety: { policyVersion: 'linky-address-v1', hostname: checked.hostname,
      result: checked.findings.some(row => row.severity === 'review') ? 'review' : 'accepted', reputation: 'unchecked' } };
}
function slug(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,96}$/u.test(value) || /ly[ori]_[0-9a-f]{64}/u.test(value)) throw new LinkyError('invalid_request');
  return value;
}
function reportRequest(value) {
  const from = value.from === null ? null : instant(value.from), to = value.to === null ? null : instant(value.to);
  if (from && to && from >= to) throw new LinkyError('invalid_request');
  return { ...scope(value), from, to, limit: number(value.limit, 50) };
}
function bulkRequest(value) {
  const workspaceId = id(value.workspaceId);
  if (!Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 50) throw new LinkyError('invalid_request');
  const seen = Object.fromEntries(['mutationKey', 'linkId', 'revisionId', 'slug'].map(key => [key, new Set()]));
  // Validate the complete batch's stable identities before preparing any row.
  const metadata = value.rows.map((row, sourceIndex) => {
    exact(row, ['mutationKey', 'linkId', 'revisionId', 'slug', 'draft']);
    const normalized = { sourceIndex, mutationKey: id(row.mutationKey), linkId: id(row.linkId), revisionId: id(row.revisionId), slug: slug(row.slug) };
    for (const key of Object.keys(seen)) {
      if (seen[key].has(normalized[key])) throw new LinkyError('conflict', 409);
      seen[key].add(normalized[key]);
    }
    return normalized;
  });
  const rows = [], invalidOutcomes = [];
  for (const row of metadata) {
    try { rows.push({ ...row, ...destination(value.rows[row.sourceIndex].draft) }); }
    catch (error) {
      if (!(error instanceof LinkyError) || error.code !== 'destination_invalid') throw error;
      const { sourceIndex, mutationKey, linkId, revisionId } = row;
      invalidOutcomes.push({ sourceIndex, mutationKey, linkId, revisionId, status: 'error', version: null, error: 'destination_invalid' });
    }
  }
  return { workspaceId, rows, invalidOutcomes };
}
function conversionRequest(value) {
  if (!['lead_declared', 'sale_declared'].includes(value.kind)) throw new LinkyError('invalid_request');
  if (value.amountMinor === null || value.currency === null) {
    if (value.amountMinor !== null || value.currency !== null) throw new LinkyError('invalid_request');
  } else if (value.kind !== 'sale_declared' || !Number.isSafeInteger(value.amountMinor) || value.amountMinor < 0
    || typeof value.currency !== 'string' || !/^[A-Z]{3}$/u.test(value.currency)) throw new LinkyError('invalid_request');
  return { credentialId: id(value.credentialId), receiptId: id(value.receiptId), eventKey: id(value.eventKey), kind: value.kind,
    amountMinor: value.amountMinor, currency: value.currency, declaredAt: instant(value.declaredAt) };
}
async function body(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new LinkyError('json_required', 415);
  const length = request.headers.get('content-length');
  if (length && (!/^[0-9]+$/u.test(length) || Number(length) > BODY_LIMIT)) throw new LinkyError('request_too_large', 413);
  const reader = request.body?.getReader(); if (!reader) throw new LinkyError('invalid_request');
  const chunks = []; let total = 0;
  const deadline = Date.now() + 5000;
  try {
    for (;;) {
      const remaining = deadline - Date.now(); if (remaining <= 0) throw new LinkyError('request_timeout', 408);
      let timer;
      const part = await Promise.race([reader.read(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new LinkyError('request_timeout', 408)), remaining);
      })]).finally(() => clearTimeout(timer));
      if (Date.now() > deadline) throw new LinkyError('request_timeout', 408);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > BODY_LIMIT) { await reader.cancel(); throw new LinkyError('request_too_large', 413); }
      chunks.push(part.value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new LinkyError('invalid_json'); }
}

const routes = Object.freeze({
  '/owner/connect': ['ownerConnect', [], () => ({})],
  '/owner/rotate': ['ownerRotate', ['workspaceId', 'mutationKey', 'newOwnerKey', 'expectedOwnerKeyVersion'], value => ({ ...mutation(value), newOwnerHash: hashCapability(value.newOwnerKey, 'owner'), expectedOwnerKeyVersion: number(value.expectedOwnerKeyVersion) })],
  '/owner/close': ['ownerClose', ['workspaceId', 'mutationKey', 'expectedOwnerKeyVersion'], value => ({ ...mutation(value), expectedOwnerKeyVersion: number(value.expectedOwnerKeyVersion) })],
  '/links/list': ['ownerListLinks', ['workspaceId', 'limit', 'after', 'state', 'search'], value => ({ ...scope(value), limit: number(value.limit, 50), after: value.after === null ? null : id(value.after), state: state(value.state, true), search: label(value.search, 200, true) })],
  '/links/create': ['ownerCreateLink', ['workspaceId', 'mutationKey', 'linkId', 'revisionId', 'slug', 'draft'], value => {
    return { ...mutation(value), linkId: id(value.linkId), revisionId: id(value.revisionId), slug: slug(value.slug), ...destination(value.draft) };
  }],
  '/links/revise': ['ownerReviseLink', ['workspaceId', 'mutationKey', 'linkId', 'revisionId', 'expectedVersion', 'draft'], value => ({ ...mutation(value), linkId: id(value.linkId), revisionId: id(value.revisionId), expectedVersion: number(value.expectedVersion), ...destination(value.draft) })],
  '/links/state': ['ownerSetLinkState', ['workspaceId', 'mutationKey', 'linkId', 'expectedVersion', 'state'], value => ({ ...mutation(value), linkId: id(value.linkId), expectedVersion: number(value.expectedVersion), state: state(value.state) })],
  '/grants/issue': ['ownerIssueGrant', ['workspaceId', 'mutationKey', 'linkId', 'revisionId', 'expectedVersion', 'grantId', 'recipientKey', 'label', 'maxUses', 'expiresAt'], value => ({ ...mutation(value), linkId: id(value.linkId), revisionId: id(value.revisionId), expectedVersion: number(value.expectedVersion), grantId: id(value.grantId), recipientHash: hashCapability(value.recipientKey, 'recipient'), label: label(value.label, 200), maxUses: number(value.maxUses, 1_000_000), expiresAt: instant(value.expiresAt) })],
  '/grants/list': ['ownerListGrants', ['workspaceId', 'linkId', 'limit', 'after'], value => ({ ...scope(value), linkId: id(value.linkId), limit: number(value.limit, 50), after: value.after === null ? null : id(value.after) })],
  '/grants/revoke': ['ownerRevokeGrant', ['workspaceId', 'mutationKey', 'linkId', 'grantId', 'expectedVersion'], value => ({ ...mutation(value), linkId: id(value.linkId), grantId: id(value.grantId), expectedVersion: number(value.expectedVersion) })],
  '/recipient/inspect': ['recipientInspect', ['grantId', 'recipientKey'], value => ({ grantId: id(value.grantId) })],
  '/recipient/redeem': ['recipientRedeem', ['grantId', 'recipientKey', 'redemptionKey'], value => ({ grantId: id(value.grantId), redemptionKey: id(value.redemptionKey) })],
  '/reports/redemptions': ['ownerReport', ['workspaceId', 'from', 'to', 'limit'], reportRequest],
  '/links/bulk-create': ['ownerBulkCreateLinks', ['workspaceId', 'rows'], bulkRequest],
  '/conversion-credentials/issue': ['ownerIssueConversionCredential', ['workspaceId', 'mutationKey', 'linkId', 'revisionId', 'expectedVersion', 'credentialId', 'ingestKey', 'label', 'expiresAt'], value => ({ ...mutation(value), linkId: id(value.linkId), revisionId: id(value.revisionId), expectedVersion: number(value.expectedVersion), credentialId: id(value.credentialId), ingestHash: hashCapability(value.ingestKey, 'ingest'), label: label(value.label, 200), expiresAt: instant(value.expiresAt) })],
  '/conversion-credentials/list': ['ownerListConversionCredentials', ['workspaceId', 'linkId', 'limit', 'after'], value => ({ ...scope(value), linkId: id(value.linkId), limit: number(value.limit, 50), after: value.after === null ? null : id(value.after) })],
  '/conversion-credentials/revoke': ['ownerRevokeConversionCredential', ['workspaceId', 'mutationKey', 'linkId', 'credentialId', 'expectedVersion'], value => ({ ...mutation(value), linkId: id(value.linkId), credentialId: id(value.credentialId), expectedVersion: number(value.expectedVersion) })],
  '/conversions/ingest': ['conversionIngest', ['credentialId', 'receiptId', 'eventKey', 'kind', 'amountMinor', 'currency', 'declaredAt'], conversionRequest],
  '/reports/attribution': ['ownerAttributionReport', ['workspaceId', 'from', 'to', 'limit'], reportRequest],
});
// Shared with the deployment adapter: rewrite hints cannot introduce a dispatcher.
export const API_ROUTES = Object.freeze(['status', ...Object.keys(routes).map(path => path.slice(1))]);

const acks = Object.freeze({
  ownerCreateLink: ['workspaceId', 'linkId', 'revisionId', 'version', 'replayed'],
  ownerReviseLink: ['workspaceId', 'linkId', 'revisionId', 'version', 'replayed'],
  ownerSetLinkState: ['workspaceId', 'linkId', 'state', 'version', 'replayed'],
  ownerIssueGrant: ['workspaceId', 'linkId', 'grantId', 'revisionId', 'version', 'replayed'],
  ownerRevokeGrant: ['workspaceId', 'linkId', 'grantId', 'version', 'replayed'],
  ownerRotate: ['workspaceId', 'ownerKeyVersion', 'replayed'],
  ownerClose: ['workspaceId', 'state', 'ownerKeyVersion', 'replayed'],
  ownerIssueConversionCredential: ['workspaceId', 'linkId', 'credentialId', 'revisionId', 'version', 'replayed'],
  ownerRevokeConversionCredential: ['workspaceId', 'linkId', 'credentialId', 'version', 'replayed'],
});
function inspectAttribution(value, payload, closed) {
  const require = condition => { if (!condition) throw new LinkyError('service_unavailable', 503); };
  const count = number => Number.isSafeInteger(number) && number >= 0 && number <= payload.limit;
  const campaign = row => {
    closed(row, ['source', 'medium', 'campaign']);
    require(Object.values(row).every(text => typeof text === 'string' && text.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(text)));
    return JSON.stringify([row.source, row.medium, row.campaign]);
  };
  const coverage = (row, kind, total) => {
    closed(row, ['kind', 'from', 'to', 'limit', 'recordCount', 'truncated']);
    require(row.kind === kind && row.limit === payload.limit && count(row.recordCount) && row.recordCount === total && typeof row.truncated === 'boolean');
    require(typeof row.from === 'string' && typeof row.to === 'string' && row.from.length <= 80 && row.to.length <= 80
      && Number.isFinite(Date.parse(row.from)) && Number.isFinite(Date.parse(row.to)) && Date.parse(row.from) < Date.parse(row.to));
  };
  closed(value, ['redemptions', 'declarations']);
  const redemptions = value.redemptions, declarations = value.declarations;
  closed(redemptions, ['count', 'campaigns', 'coverage']);
  closed(declarations, ['total', 'leads', 'sales', 'unknownValueSales', 'campaigns', 'currencies', 'coverage']);
  require(count(redemptions.count) && Array.isArray(redemptions.campaigns) && redemptions.campaigns.length <= payload.limit);
  const redemptionCampaigns = new Set();
  for (const row of redemptions.campaigns) {
    closed(row, ['campaign', 'count']); const key = campaign(row.campaign);
    require(!redemptionCampaigns.has(key) && count(row.count) && row.count > 0); redemptionCampaigns.add(key);
  }
  require(redemptions.campaigns.reduce((total, row) => total + row.count, 0) === redemptions.count);
  coverage(redemptions.coverage, 'committed_redemptions', redemptions.count);
  require(['total', 'leads', 'sales', 'unknownValueSales'].every(key => count(declarations[key]))
    && declarations.total === declarations.leads + declarations.sales && declarations.unknownValueSales <= declarations.sales
    && Array.isArray(declarations.campaigns) && declarations.campaigns.length <= payload.limit
    && Array.isArray(declarations.currencies) && declarations.currencies.length <= payload.limit);
  const declarationCampaigns = new Set();
  for (const row of declarations.campaigns) {
    closed(row, ['campaign', 'leads', 'sales', 'unknownValueSales']); const key = campaign(row.campaign);
    require(!declarationCampaigns.has(key) && ['leads', 'sales', 'unknownValueSales'].every(key => count(row[key]))
      && row.leads + row.sales > 0 && row.unknownValueSales <= row.sales); declarationCampaigns.add(key);
  }
  for (const key of ['leads', 'sales', 'unknownValueSales']) require(declarations.campaigns.reduce((total, row) => total + row[key], 0) === declarations[key]);
  const currencies = new Set();
  for (const row of declarations.currencies) {
    closed(row, ['currency', 'amountMinor', 'sales']);
    require(typeof row.currency === 'string' && /^[A-Z]{3}$/u.test(row.currency) && !currencies.has(row.currency)
      && count(row.sales) && row.sales > 0 && typeof row.amountMinor === 'string' && /^(?:0|[1-9][0-9]{0,31})$/u.test(row.amountMinor));
    require(BigInt(row.amountMinor) <= BigInt(Number.MAX_SAFE_INTEGER) * BigInt(row.sales)); currencies.add(row.currency);
  }
  require(declarations.currencies.reduce((total, row) => total + row.sales, 0) === declarations.sales - declarations.unknownValueSales);
  coverage(declarations.coverage, 'accepted_conversion_declarations', declarations.total);
}
function inspectResult(method, value, payload) {
  const text = JSON.stringify(value);
  if (!text || Buffer.byteLength(text) > 256 * 1024 || /ly[ori]_[0-9a-f]{64}/u.test(text)) throw new LinkyError('service_unavailable', 503);
  value = JSON.parse(text);
  const closed = (object, fields) => {
    if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).length !== fields.length
      || fields.some(key => !Object.hasOwn(object, key))) throw new LinkyError('service_unavailable', 503);
  };
  const visit = object => {
    if (!object || typeof object !== 'object') return;
    for (const [key, child] of Object.entries(object)) {
      if (/hash|secret|token|credential|^(?:owner|recipient|ingest)key$/iu.test(key)
        && !['credentialId', 'credentials'].includes(key)) throw new LinkyError('service_unavailable', 503);
      visit(child);
    }
  };
  visit(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LinkyError('service_unavailable', 503);
  if (acks[method]) {
    closed(value, acks[method]);
    if (typeof value.replayed !== 'boolean') throw new LinkyError('service_unavailable', 503);
    for (const key of ['version', 'ownerKeyVersion']) if (key in value && (!Number.isSafeInteger(value[key]) || value[key] < 1)) throw new LinkyError('service_unavailable', 503);
    if ((method === 'ownerClose' && value.state !== 'closed') || (method === 'ownerSetLinkState' && value.state !== payload.state)) throw new LinkyError('service_unavailable', 503);
    for (const key of ['workspaceId', 'linkId', 'revisionId', 'grantId', 'credentialId']) if (key in value && value[key] !== payload[key]) throw new LinkyError('service_unavailable', 503);
  } else if (method === 'ownerConnect') {
    closed(value, ['workspace']); closed(value.workspace, ['id', 'name', 'state', 'ownerKeyVersion']);
  } else if (method === 'ownerListLinks') {
    closed(value, ['links', 'nextCursor']);
    if (!Array.isArray(value.links) || value.links.length > payload.limit) throw new LinkyError('service_unavailable', 503);
    for (const link of value.links) closed(link, ['id', 'slug', 'label', 'state', 'version', 'currentRevisionId', 'destination', 'campaign', 'safety', 'createdAt', 'updatedAt']);
  } else if (method === 'ownerListGrants') {
    closed(value, ['grants', 'nextCursor']);
    if (!Array.isArray(value.grants) || value.grants.length > payload.limit) throw new LinkyError('service_unavailable', 503);
    for (const grant of value.grants) { closed(grant, ['id', 'linkId', 'revisionId', 'label', 'maxUses', 'usedCount', 'expiresAt', 'revokedAt', 'createdAt']); if (grant.linkId !== payload.linkId) throw new LinkyError('service_unavailable', 503); }
  } else if (method === 'ownerListConversionCredentials') {
    closed(value, ['credentials', 'nextCursor']);
    if (!Array.isArray(value.credentials) || value.credentials.length > payload.limit || (value.nextCursor !== null && !UUID.test(value.nextCursor))) throw new LinkyError('service_unavailable', 503);
    for (const credential of value.credentials) {
      closed(credential, ['id', 'linkId', 'revisionId', 'label', 'purpose', 'expiresAt', 'revokedAt', 'createdAt']);
      if (credential.linkId !== payload.linkId || credential.purpose !== 'conversion_ingest' || !UUID.test(credential.id) || !UUID.test(credential.revisionId)) throw new LinkyError('service_unavailable', 503);
    }
  } else if (method === 'conversionIngest') {
    closed(value, ['eventId', 'workspaceId', 'linkId', 'revisionId', 'receiptId', 'eventKey', 'kind', 'acceptedAt', 'replayed']);
    if (value.receiptId !== payload.receiptId || value.eventKey !== payload.eventKey || value.kind !== payload.kind || typeof value.replayed !== 'boolean'
      || ['eventId', 'workspaceId', 'linkId', 'revisionId'].some(key => !UUID.test(value[key])) || !Number.isFinite(Date.parse(value.acceptedAt))) throw new LinkyError('service_unavailable', 503);
  } else if (method === 'ownerBulkCreateLinks') {
    closed(value, ['outcomes']);
    if (!Array.isArray(value.outcomes) || value.outcomes.length !== payload.rows.length) throw new LinkyError('service_unavailable', 503);
    const expected = new Map(payload.rows.map(row => [row.sourceIndex, row])), seen = new Set();
    for (const row of value.outcomes) {
      closed(row, ['sourceIndex', 'mutationKey', 'linkId', 'revisionId', 'status', 'version', 'error']);
      const wanted = expected.get(row.sourceIndex);
      if (!wanted || seen.has(row.sourceIndex) || ['mutationKey', 'linkId', 'revisionId'].some(key => row[key] !== wanted[key])) throw new LinkyError('service_unavailable', 503);
      seen.add(row.sourceIndex);
      if (row.status === 'error') {
        if (row.version !== null || typeof row.error !== 'string') throw new LinkyError('service_unavailable', 503);
        const safe = publicError({ code: 'P0001', message: row.error });
        if (safe.code === 'service_unavailable' && row.error !== 'linky_unavailable') throw safe;
        row.error = safe.code;
      } else if (!['committed', 'replayed'].includes(row.status) || row.error !== null || !Number.isSafeInteger(row.version) || row.version < 1) throw new LinkyError('service_unavailable', 503);
    }
  } else if (method === 'ownerAttributionReport') {
    inspectAttribution(value, payload, closed);
  } else if (method === 'recipientInspect') closed(value, ['grantId', 'linkId', 'label', 'hostname', 'safety', 'expiresAt', 'remainingUses']);
  else if (method === 'recipientRedeem') closed(value, ['receiptId', 'grantId', 'linkId', 'revisionId', 'useNumber', 'redeemedAt', 'destination', 'replayed']);
  else if (method === 'ownerReport') {
    closed(value, ['redemptions', 'campaigns', 'coverage', 'conversionsAvailable']);
    closed(value.coverage, ['kind', 'from', 'to', 'limit', 'recordCount', 'truncated']);
    if (!Number.isSafeInteger(value.redemptions) || value.redemptions < 0 || !Array.isArray(value.campaigns) || value.campaigns.length > payload.limit || value.conversionsAvailable !== false) throw new LinkyError('service_unavailable', 503);
    if (value.coverage.kind !== 'committed_redemptions' || !Number.isSafeInteger(value.coverage.recordCount) || value.coverage.recordCount < 0 || typeof value.coverage.truncated !== 'boolean') throw new LinkyError('service_unavailable', 503);
    if (value.coverage.limit !== payload.limit || value.coverage.recordCount > payload.limit || value.redemptions !== value.coverage.recordCount) throw new LinkyError('service_unavailable', 503);
    for (const campaign of value.campaigns) { closed(campaign, ['campaign', 'redemptions']); closed(campaign.campaign, ['source', 'medium', 'campaign']); if (!Number.isSafeInteger(campaign.redemptions) || campaign.redemptions < 0) throw new LinkyError('service_unavailable', 503); }
    if (value.campaigns.reduce((total, row) => total + row.redemptions, 0) !== value.redemptions) throw new LinkyError('service_unavailable', 503);
  }
  if (method.startsWith('recipient') && value.grantId !== payload.grantId) throw new LinkyError('service_unavailable', 503);
  if (method !== 'recipientRedeem' && method !== 'ownerListLinks' && /"destination"\s*:/u.test(text)) throw new LinkyError('service_unavailable', 503);
  return value;
}
function response(data, status = 200, head = false) {
  return new Response(head ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'", vary: 'Origin, Authorization' } });
}
function canonicalOrigin(value, allowInsecureLoopback) {
  let url; try { url = new URL(value); } catch { return null; }
  if (url.origin !== value || url.username || url.password) return null;
  if (url.protocol === 'https:') return value;
  if (allowInsecureLoopback && process.env.CI === 'true' && url.protocol === 'http:' && url.hostname === '127.0.0.1') return value;
  return null;
}

export function createHandler({ repository = null, origin, allowInsecureLoopback = false } = {}) {
  const acceptedOrigin = canonicalOrigin(origin, allowInsecureLoopback);
  return async request => {
    const head = request.method === 'HEAD';
    let ingestion = false;
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/status' && ['GET', 'HEAD'].includes(request.method)) {
        if (url.search) throw new LinkyError('invalid_request');
        return response({ service: 'linky', configuration: acceptedOrigin && repository ? 'present' : 'required', database: 'unverified', conversionsAvailable: true }, 200, head);
      }
      const suffix = url.pathname.replace(/^\/api\/v1/u, '');
      const route = Object.hasOwn(routes, suffix) ? routes[suffix] : null;
      if (!url.pathname.startsWith('/api/v1/') || !route) throw new LinkyError('not_found', 404);
      if (request.method !== 'POST') throw new LinkyError('method_not_allowed', 405);
      if (!acceptedOrigin || !repository) throw new LinkyError('backend_unconfigured', 503);
      ingestion = route[0] === 'conversionIngest';
      const originRequired = !ingestion || request.headers.has('origin');
      if (url.origin !== acceptedOrigin || (originRequired && request.headers.get('origin') !== acceptedOrigin)
        || (request.headers.has('sec-fetch-site') && !['same-origin', 'none'].includes(request.headers.get('sec-fetch-site')))) throw new LinkyError('origin_denied', 403);
      if (ingestion && request.headers.has('cookie')) throw new LinkyError('invalid_credential', 401);
      if (url.search) throw new LinkyError('invalid_request');
      const [method, fields, normalize] = route;
      const input = exact(await body(request), fields);
      const recipient = method.startsWith('recipient');
      if (recipient && request.headers.has('authorization')) throw new LinkyError('invalid_credential', 401);
      const digest = recipient ? hashCapability(input.recipientKey, 'recipient') : ingestion ? headerDigest(request, 'ingest') : ownerDigest(request);
      const payload = normalize(input);
      const localOnly = method === 'ownerBulkCreateLinks' && payload.rows.length === 0;
      const target = localOnly ? null : typeof repository === 'function' ? await repository() : repository;
      if (!localOnly && (!target || typeof target[method] !== 'function')) throw new LinkyError('backend_unconfigured', 503);
      const sqlPayload = method === 'ownerBulkCreateLinks' ? { workspaceId: payload.workspaceId, rows: payload.rows } : payload;
      const raw = localOnly ? { outcomes: [] } : await target[method](digest, sqlPayload);
      const result = inspectResult(method, raw, payload);
      if (method === 'ownerBulkCreateLinks') result.outcomes = [...result.outcomes, ...payload.invalidOutcomes].sort((left, right) => left.sourceIndex - right.sourceIndex);
      if (method === 'ownerAttributionReport') result.conversionsAvailable = true;
      if (input.mutationKey) result.mutationKey = id(input.mutationKey);
      return response(result);
    } catch (error) {
      const safe = publicError(error);
      const code = ingestion && safe.code === 'grant_expired' ? 'credential_expired'
        : ingestion && safe.code === 'grant_revoked' ? 'credential_revoked' : safe.code;
      return response({ error: { code } }, safe.status, head);
    }
  };
}
