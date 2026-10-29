export const DESTINATION_LIMITS = Object.freeze({ title: 200, url: 2048, campaign: 100, csvBytes: 1_048_576, csvRows: 500 });

const FIELDS = Object.freeze(['title', 'destination', 'source', 'medium', 'campaign']);
const UTM_FIELDS = Object.freeze([['source', 'utm_source'], ['medium', 'utm_medium'], ['campaign', 'utm_campaign']]);
const MESSAGES = Object.freeze({
  draft_invalid: 'Use exactly the five link fields, with text values.',
  title_invalid: 'The title must contain at most 200 characters.',
  destination_invalid: 'The destination must contain at most 2048 characters.',
  campaign_invalid: 'Each campaign field must contain at most 100 characters.',
  text_invalid: 'Use valid Unicode text without null characters.',
  title_required: 'Add a title before preparing this link.',
  destination_required: 'Add a destination before preparing this link.',
  destination_blocked: 'Review the blocked destination before preparing this link.',
  csv_invalid: 'Use a valid CSV file with properly quoted fields.',
  csv_headers_invalid: 'Use these exact CSV headers: title,destination,source,medium,campaign.',
  csv_too_large: 'The CSV preview is limited to 1 MiB of UTF-8 text.',
  csv_rows_exceeded: 'The CSV preview is limited to 500 data rows.',
  csv_columns_invalid: 'Each data row must contain exactly five fields.',
});

export class DestinationError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'draft_invalid';
    super(MESSAGES[safeCode]);
    this.name = 'DestinationError';
    this.code = safeCode;
  }
}

function fail(code) { throw new DestinationError(code); }

function wellFormed(value, allowNull = false) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0 && !allowNull) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function exactRecord(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === fields.length
    && fields.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string';
    });
}

export function normalizeLinkDraft(value) {
  if (!exactRecord(value, FIELDS)) fail('draft_invalid');
  const draft = {};
  for (const field of FIELDS) {
    const text = value[field];
    if (!wellFormed(text)) fail('text_invalid');
    if (field === 'destination' && /[\u0000-\u001f\u007f]/u.test(text)) fail('destination_invalid');
    if (!['title', 'destination'].includes(field) && /[\u0000-\u001f\u007f]/u.test(text)) fail('campaign_invalid');
    const limit = field === 'title' ? DESTINATION_LIMITS.title : field === 'destination' ? DESTINATION_LIMITS.url : DESTINATION_LIMITS.campaign;
    if (text.length > limit) fail(field === 'title' ? 'title_invalid' : field === 'destination' ? 'destination_invalid' : 'campaign_invalid');
    draft[field] = text.trim();
  }
  return Object.freeze(draft);
}

function finding(code, severity, message) { return Object.freeze({ code, severity, message }); }

function nonPublicV4(host) {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

function expandV6(host) {
  const halves = host.slice(1, -1).split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const words = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  return words.length === 8 ? words.map((part) => Number.parseInt(part, 16)) : null;
}

function nonPublicV6(host) {
  const words = expandV6(host);
  if (!words || words.some((word) => !Number.isInteger(word))) return true;
  const [a, b] = words;
  // Conservative literal-address review, not DNS resolution or a reachability guarantee.
  return a < 0x2000 || a > 0x3fff || (a === 0x2001 && b < 0x0200)
    || (a === 0x2001 && b === 0x0db8) || a === 0x2002 || (a === 0x3fff && b < 0x1000);
}

export function analyzeDestination(value) {
  if (typeof value !== 'string' || value.length > DESTINATION_LIMITS.url || !wellFormed(value, true)) fail('destination_invalid');
  const raw = value.trim();
  const findings = [];
  let parsed;
  if (/[\u0000-\u001f\u007f]/u.test(value) || /[\u0020\\]/u.test(raw)) {
    findings.push(finding('url_characters', 'blocked', 'The URL contains whitespace, controls or a backslash.'));
  }
  try { parsed = new URL(raw); } catch {
    findings.push(finding('url_invalid', 'blocked', 'Use an absolute HTTP or HTTPS destination.'));
    return Object.freeze({ url: raw, hostname: '', findings: Object.freeze(findings), reputation: 'unchecked' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !/^https?:\/\//iu.test(raw)) {
    findings.push(finding('url_scheme', 'blocked', 'Use an absolute HTTP or HTTPS destination.'));
  }
  if (parsed.username || parsed.password) findings.push(finding('url_credentials', 'blocked', 'URLs containing embedded credentials cannot be prepared.'));
  if (parsed.port) findings.push(finding('url_port', 'blocked', 'Use the default HTTP or HTTPS port.'));
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/u.test(hostname);
  const ipv6 = hostname.startsWith('[') && hostname.endsWith(']');
  if (!ipv4 && !ipv6 && hostname.split('.').some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))) {
    findings.push(finding('host_syntax', 'blocked', 'Use a qualified hostname with valid nonempty labels.'));
  }
  if (!hostname || (!ipv4 && !ipv6 && (!hostname.includes('.') || hostname === 'home.arpa' || hostname.endsWith('.home.arpa')
    || /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example|onion)$/u.test(hostname)))) {
    findings.push(finding('host_nonpublic', 'blocked', 'This hostname is local, reserved or not a public qualified hostname.'));
  } else if ((ipv4 && nonPublicV4(hostname)) || (ipv6 && nonPublicV6(hostname))) {
    findings.push(finding('address_nonpublic', 'blocked', 'This literal address is private, local, special-purpose or outside the reviewed public range.'));
  } else if (ipv4 || ipv6) {
    findings.push(finding('address_literal', 'review', 'This is a literal IP address; confirm the intended destination.'));
  }
  if (hostname.split('.').some((part) => part.startsWith('xn--'))) findings.push(finding('host_international', 'review', 'Review the encoded international hostname carefully.'));
  if (parsed.protocol === 'http:') findings.push(finding('transport_http', 'review', 'This destination does not use HTTPS.'));
  findings.push(finding('reputation_unchecked', 'notice', 'No DNS, redirect, malware or reputation check has been performed.'));
  return Object.freeze({ url: parsed.href, hostname, findings: Object.freeze(findings), reputation: 'unchecked' });
}

export function buildDestination(value) {
  const draft = normalizeLinkDraft(value);
  if (!draft.title) fail('title_required');
  if (!draft.destination) fail('destination_required');
  const analysis = analyzeDestination(draft.destination);
  if (analysis.findings.some(({ severity }) => severity === 'blocked')) fail('destination_blocked');
  const url = new URL(analysis.url);
  const replacedParameters = [];
  const owned = new Set(UTM_FIELDS.map(([, parameter]) => parameter));
  const retained = (url.search ? url.search.slice(1).split('&') : []).filter((entry) => {
    let key;
    try { key = decodeURIComponent(entry.split('=', 1)[0].replace(/\+/gu, ' ')); } catch { return true; }
    if (!owned.has(key)) return true;
    if (!replacedParameters.includes(key)) replacedParameters.push(key);
    return false;
  });
  for (const [field, parameter] of UTM_FIELDS) {
    if (draft[field]) retained.push(new URLSearchParams([[parameter, draft[field]]]).toString());
  }
  url.search = retained.length ? `?${retained.join('&')}` : '';
  if (url.href.length > DESTINATION_LIMITS.url) fail('destination_invalid');
  return Object.freeze({ url: url.href, draft, replacedParameters: Object.freeze(replacedParameters) });
}

function csvRecords(text) {
  const records = [];
  let fields = [], value = '', state = 'start', line = 1, recordLine = 1, touched = false;
  function finishField() { fields.push(value); value = ''; state = 'start'; }
  function finishRecord() {
    finishField();
    records.push({ fields, line: recordLine });
    if (records.length > DESTINATION_LIMITS.csvRows + 1) fail('csv_rows_exceeded');
    fields = []; touched = false;
  }
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (state === 'quoted') {
      if (character === '"') {
        if (text[index + 1] === '"') { value += '"'; index += 1; }
        else state = 'closed';
      } else {
        value += character;
        if (character === '\n' || (character === '\r' && text[index + 1] !== '\n')) line += 1;
      }
      continue;
    }
    if (character === ',') { finishField(); touched = true; continue; }
    if (character === '\n' || character === '\r') {
      if (character === '\r') {
        if (text[index + 1] !== '\n') fail('csv_invalid');
        index += 1;
      }
      finishRecord(); line += 1; recordLine = line; continue;
    }
    if (state === 'closed') fail('csv_invalid');
    if (character === '"') {
      if (state !== 'start') fail('csv_invalid');
      state = 'quoted'; touched = true;
    } else { value += character; state = 'plain'; touched = true; }
  }
  if (state === 'quoted') fail('csv_invalid');
  if (touched || fields.length || value.length) finishRecord();
  return records;
}

export function parseBulkCsv(text) {
  if (typeof text !== 'string' || !wellFormed(text)) fail('csv_invalid');
  if (text.length > DESTINATION_LIMITS.csvBytes || new TextEncoder().encode(text).byteLength > DESTINATION_LIMITS.csvBytes) fail('csv_too_large');
  const records = csvRecords(text.startsWith('\ufeff') ? text.slice(1) : text);
  const header = records.shift();
  if (!header || header.fields.length !== FIELDS.length || header.fields.some((field, index) => field !== FIELDS[index])) fail('csv_headers_invalid');
  const rows = records.map((record, index) => {
    let draft = null, destination = null;
    const errors = [];
    if (record.fields.length !== FIELDS.length) errors.push(Object.freeze({ code: 'csv_columns_invalid', message: MESSAGES.csv_columns_invalid }));
    else {
      try {
        draft = normalizeLinkDraft(Object.fromEntries(FIELDS.map((field, fieldIndex) => [field, record.fields[fieldIndex]])));
        destination = buildDestination(draft);
      } catch (error) {
        const safe = new DestinationError(error instanceof DestinationError ? error.code : 'draft_invalid');
        errors.push(Object.freeze({ code: safe.code, message: safe.message }));
      }
    }
    return Object.freeze({ row: index + 1, line: record.line, draft, destination, errors: Object.freeze(errors) });
  });
  const validCount = rows.filter((row) => row.errors.length === 0).length;
  return Object.freeze({ headers: FIELDS, rows: Object.freeze(rows), validCount, invalidCount: rows.length - validCount });
}
