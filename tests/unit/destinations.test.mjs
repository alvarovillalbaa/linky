import test from 'node:test';
import assert from 'node:assert/strict';
import { DestinationError, normalizeLinkDraft, buildDestination, analyzeDestination, parseBulkCsv } from '../../public/src/destinations.mjs';

const headers = 'title,destination,source,medium,campaign';
const draft = (overrides = {}) => ({ title: 'Authored link', destination: 'https://example.com/path', source: '', medium: '', campaign: '', ...overrides });
const code = (expected) => (error) => error instanceof DestinationError && error.code === expected;
const blocked = (value, expected) => assert.ok(analyzeDestination(value).findings.some((item) => item.code === expected && item.severity === 'blocked'));

test('draft normalization permits unfinished fields and returns detached frozen text', () => {
  const input = draft({ title: '  ', destination: '', source: ' authored ' });
  const normalized = normalizeLinkDraft(input);
  assert.deepEqual(normalized, { title: '', destination: '', source: 'authored', medium: '', campaign: '' });
  input.source = 'changed';
  assert.equal(normalized.source, 'authored');
  assert.ok(Object.isFrozen(normalized));
  for (const input of [null, [], {}, draft({ extra: '' }), { ...draft(), source: 3 }]) assert.throws(() => normalizeLinkDraft(input), code('draft_invalid'));
  const getter = { ...draft() };
  Object.defineProperty(getter, 'title', { get() { throw new Error('must not be read'); }, enumerable: true });
  assert.throws(() => normalizeLinkDraft(getter), code('draft_invalid'));
  for (const descriptor of [{ set() { throw new Error('must not be called'); }, enumerable: true }, { value: 'hidden title', enumerable: false }]) {
    const input = { ...draft() };
    Object.defineProperty(input, 'title', descriptor);
    assert.throws(() => normalizeLinkDraft(input), code('draft_invalid'));
  }
});

test('draft field bounds and Unicode validity preserve complete astral text', () => {
  assert.equal(normalizeLinkDraft(draft({ title: 'x'.repeat(200), source: '🌍'.repeat(50) })).source.length, 100);
  assert.throws(() => normalizeLinkDraft(draft({ title: 'x'.repeat(201) })), code('title_invalid'));
  assert.throws(() => normalizeLinkDraft(draft({ destination: 'x'.repeat(2049) })), code('destination_invalid'));
  assert.throws(() => normalizeLinkDraft(draft({ medium: 'x'.repeat(101) })), code('campaign_invalid'));
  assert.throws(() => normalizeLinkDraft(draft({ source: 'line\nbreak' })), code('campaign_invalid'));
  for (const text of ['bad\u0000text', '\ud800', '\udfff']) assert.throws(() => normalizeLinkDraft(draft({ campaign: text })), code('text_invalid'));
});

test('preparing campaign parameters retains unrelated query bytes and the fragment', () => {
  const result = buildDestination(draft({ destination: 'https://example.com/a?sig=~%2f&label=a%20b&repeat=1&repeat=2#part%202', source: 'friends' }));
  assert.equal(result.url, 'https://example.com/a?sig=~%2f&label=a%20b&repeat=1&repeat=2&utm_source=friends#part%202');
  assert.deepEqual(result.replacedParameters, []);
});

test('owned UTM collisions replace every occurrence while blank fields remove them', () => {
  const result = buildDestination(draft({ destination: 'https://example.com/?utm_source=old&keep=1&utm_source=other&%75tm_medium=old&UTM_SOURCE=unowned#keep', source: 'new' }));
  assert.equal(result.url, 'https://example.com/?keep=1&UTM_SOURCE=unowned&utm_source=new#keep');
  assert.deepEqual(result.replacedParameters, ['utm_source', 'utm_medium']);
  assert.ok(Object.isFrozen(result.replacedParameters));
});

test('campaign values use URL encoding without becoming extra parameters', () => {
  const result = buildDestination(draft({ source: 'friends & family', medium: 'a+b', campaign: 'café 🌍' }));
  assert.equal(result.url, 'https://example.com/path?utm_source=friends+%26+family&utm_medium=a%2Bb&utm_campaign=caf%C3%A9+%F0%9F%8C%8D');
  assert.deepEqual(result.draft, draft({ source: 'friends & family', medium: 'a+b', campaign: 'café 🌍' }));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.draft));
});

test('preparation requires title and destination and applies the final URL bound', () => {
  assert.throws(() => buildDestination(draft({ title: '' })), code('title_required'));
  assert.throws(() => buildDestination(draft({ destination: '' })), code('destination_required'));
  assert.throws(() => buildDestination(draft({ destination: 'https://example.com/' + 'a'.repeat(2010), campaign: 'x'.repeat(100) })), code('destination_invalid'));
  assert.throws(() => buildDestination(draft({ destination: '/relative' })), code('destination_blocked'));
});

test('scheme credentials controls backslashes and nondefault ports are blocked', () => {
  blocked('javascript:alert(1)', 'url_scheme');
  blocked('https://user:password@example.com/', 'url_credentials');
  blocked('https://example.com:444/', 'url_port');
  for (const value of ['https://example.com/a b', 'https://exam\tple.com/', '\nhttps://example.com/', '\u0000https://example.com/', 'https:\\example.com']) blocked(value, 'url_characters');
  assert.throws(() => buildDestination(draft({ destination: '\nhttps://example.com/' })), code('destination_invalid'));
  assert.equal(buildDestination(draft({ destination: 'https://example.com:443/' })).url, 'https://example.com/');
});

test('private and special IPv4 literals remain blocked after URL normalization', () => {
  for (const host of ['127.0.0.1', '127.1', '2130706433', '0x7f000001', '10.1.2.3', '100.64.0.1', '169.254.169.254', '172.31.2.3', '192.168.1.2', '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '255.255.255.255']) blocked(`https://${host}/`, 'address_nonpublic');
});

test('local mapped documentation and transition IPv6 literals are blocked', () => {
  for (const host of ['[::1]', '[::]', '[fc00::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[2001:db8::1]', '[2001::1]', '[2002::1]', '[3fff::1]']) blocked(`https://${host}/`, 'address_nonpublic');
});

test('public literal international hostname and HTTP findings remain unverified warnings', () => {
  const literal = analyzeDestination('https://8.8.8.8/');
  assert.ok(literal.findings.some(({ code, severity }) => code === 'address_literal' && severity === 'review'));
  assert.equal(literal.reputation, 'unchecked');
  const international = analyzeDestination('http://bücher.example.com/');
  assert.equal(international.hostname, 'xn--bcher-kva.example.com');
  assert.deepEqual(international.findings.map(({ code }) => code), ['host_international', 'transport_http', 'reputation_unchecked']);
  assert.ok(Object.isFrozen(international.findings) && international.findings.every(Object.isFrozen));
});

test('local reserved and single-label hostnames cannot be prepared', () => {
  for (const host of ['localhost', 'localhost.', 'app.localhost', 'app.local', 'metadata.google.internal', 'office.lan', 'app.test', 'site.invalid', 'site.onion', 'intranet', 'home.arpa', 'home.arpa.', 'router.home.arpa']) blocked(`https://${host}/`, 'host_nonpublic');
  assert.throws(() => buildDestination(draft({ destination: 'https://metadata.google.internal/' })), code('destination_blocked'));
  blocked('https://example..com/', 'host_syntax');
  assert.equal(analyzeDestination('https://example.com/').findings.some(({ severity }) => severity === 'blocked'), false);
  assert.equal(analyzeDestination('https://home.arpa.example.com/').findings.some(({ severity }) => severity === 'blocked'), false);
});

test('CSV supports BOM CRLF escaped quotes commas and quoted physical newlines', () => {
  const preview = parseBulkCsv('\ufeff' + headers + '\r\n"First, \"\"authored\"\"\nline",https://example.com/one,social,,spring\r\nSecond,https://example.com/two,,,\r\n');
  assert.equal(preview.validCount, 2);
  assert.equal(preview.rows[0].draft.title, 'First, "authored"\nline');
  assert.deepEqual(preview.rows.map(({ row, line }) => ({ row, line })), [{ row: 1, line: 2 }, { row: 2, line: 4 }]);
  assert.equal(preview.rows[0].destination.url, 'https://example.com/one?utm_source=social&utm_campaign=spring');
});

test('CSV returns independent row failures while retaining valid drafts for review', () => {
  const preview = parseBulkCsv(headers + '\nGood,https://example.com/,,,\n,https://example.com/,,,\nBad,http://localhost/,,,\nToo,few\n');
  assert.equal(preview.validCount, 1);
  assert.equal(preview.invalidCount, 3);
  assert.deepEqual(preview.rows.map(({ errors }) => errors.map(({ code }) => code)), [[], ['title_required'], ['destination_blocked'], ['csv_columns_invalid']]);
  assert.equal(preview.rows[1].draft.title, '');
  assert.equal(preview.rows[1].destination, null);
  assert.equal(preview.rows[3].draft, null);
});

test('CSV headers require the exact five columns in the declared order', () => {
  for (const input of ['', 'title,url,source,medium,campaign', 'title,destination,source,medium', 'destination,title,source,medium,campaign', headers + ',extra']) assert.throws(() => parseBulkCsv(input), code('csv_headers_invalid'));
  assert.deepEqual(parseBulkCsv(headers).rows, []);
});

test('CSV rejects unterminated quotes stray quotes trailing quoted text and bare CR', () => {
  for (const row of ['"unfinished,https://example.com/,,,', 'bad"quote,https://example.com/,,,', '"quoted"x,https://example.com/,,,', 'Authored,https://example.com/,,,\rNext,https://example.com/,,,']) assert.throws(() => parseBulkCsv(headers + '\n' + row), code('csv_invalid'));
});

test('CSV enforces data-row and actual UTF-8 byte budgets', () => {
  const row = 'Authored,https://example.com/,,,\n';
  assert.equal(parseBulkCsv(headers + '\n' + row.repeat(500)).rows.length, 500);
  assert.throws(() => parseBulkCsv(headers + '\n' + row.repeat(501)), code('csv_rows_exceeded'));
  assert.throws(() => parseBulkCsv('é'.repeat(524_289)), code('csv_too_large'));
  assert.throws(() => parseBulkCsv('a'.repeat(1_048_577)), code('csv_too_large'));
});

test('CSV reports field bounds per row and rejects malformed source Unicode', () => {
  const preview = parseBulkCsv(headers + '\n' + 'x'.repeat(201) + ',https://example.com/,,,\nUnicode 🌍,https://example.com/,,,');
  assert.equal(preview.invalidCount, 1);
  assert.equal(preview.validCount, 1);
  assert.equal(preview.rows[0].errors[0].code, 'title_invalid');
  for (const text of ['\ud800', '\udfff', '\u0000']) assert.throws(() => parseBulkCsv(headers + '\n' + text), code('csv_invalid'));
});

test('CSV previews are immutable and contain no persistence or execution receipts', () => {
  const preview = parseBulkCsv(headers + '\nAuthored,https://example.com/,,,');
  assert.ok(Object.isFrozen(preview) && Object.isFrozen(preview.headers) && Object.isFrozen(preview.rows));
  assert.ok(Object.isFrozen(preview.rows[0]) && Object.isFrozen(preview.rows[0].errors));
  assert.throws(() => { preview.rows[0].draft.title = 'changed'; }, TypeError);
  assert.deepEqual(Object.keys(preview), ['headers', 'rows', 'validCount', 'invalidCount']);
});
