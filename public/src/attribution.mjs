const MAX_EVENTS = 10_000;
const EVENT_FIELDS = Object.freeze(['id', 'type', 'receiptId', 'linkId', 'revisionId', 'campaign', 'occurredAt', 'conversion']);
const CAMPAIGN_FIELDS = Object.freeze(['source', 'medium', 'campaign']);
const CONVERSION_FIELDS = Object.freeze(['kind', 'valueMinor', 'currency']);
const ID = /^[\x21-\x7e]{1,128}$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;
const MESSAGES = Object.freeze({
  attribution_invalid: 'Use a bounded array of complete supplied attribution records.',
  event_invalid: 'An attribution record has invalid fields or values.',
  event_duplicate: 'Each supplied attribution event ID must be unique.',
  receipt_duplicate: 'Each supplied redemption receipt must appear exactly once.',
  receipt_missing: 'Every conversion must refer to a supplied redemption receipt.',
  binding_mismatch: 'A conversion must retain its receipt’s link, revision and campaign bindings.',
  event_order_invalid: 'A conversion cannot precede its supplied redemption.',
  total_overflow: 'A currency total exceeds the supported exact integer range.',
});

export class AttributionError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'attribution_invalid';
    super(MESSAGES[safeCode]);
    this.name = 'AttributionError';
    this.code = safeCode;
  }
}

function fail(code) { throw new AttributionError(code); }
function exact(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === fields.length
    && fields.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    });
}

function validText(value, limit) {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function timestamp(value) {
  if (typeof value !== 'string') fail('event_invalid');
  const match = DATE.exec(value);
  if (!match) fail('event_invalid');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59
    || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) fail('event_invalid');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail('event_invalid');
  const iso = new Date(milliseconds).toISOString();
  if (!/^\d{4}-/u.test(iso)) fail('event_invalid');
  return iso;
}

function snapshotEvent(value) {
  if (!exact(value, EVENT_FIELDS) || !['redemption', 'conversion'].includes(value.type)
    || ![value.id, value.receiptId, value.linkId, value.revisionId].every((id) => typeof id === 'string' && ID.test(id))
    || !exact(value.campaign, CAMPAIGN_FIELDS)
    || !CAMPAIGN_FIELDS.every((field) => validText(value.campaign[field], 100))) fail('event_invalid');
  const campaign = Object.freeze(Object.fromEntries(CAMPAIGN_FIELDS.map((field) => [field, value.campaign[field]])));
  let conversion = null;
  if (value.type === 'redemption') {
    if (value.conversion !== null) fail('event_invalid');
  } else {
    const supplied = value.conversion;
    if (!exact(supplied, CONVERSION_FIELDS) || !['lead', 'sale'].includes(supplied.kind)) fail('event_invalid');
    const unknown = supplied.valueMinor === null && supplied.currency === null;
    const valued = Number.isSafeInteger(supplied.valueMinor) && supplied.valueMinor >= 0
      && typeof supplied.currency === 'string' && /^[A-Z]{3}$/u.test(supplied.currency);
    if ((!unknown && !valued) || (supplied.kind === 'lead' && !unknown)) fail('event_invalid');
    conversion = Object.freeze({ kind: supplied.kind, valueMinor: supplied.valueMinor, currency: supplied.currency });
  }
  return Object.freeze({ id: value.id, type: value.type, receiptId: value.receiptId, linkId: value.linkId,
    revisionId: value.revisionId, campaign, occurredAt: timestamp(value.occurredAt), conversion });
}

function campaignKey(campaign) { return JSON.stringify(CAMPAIGN_FIELDS.map((field) => campaign[field])); }
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

export function summarizeAttribution(events) {
  if (!Array.isArray(events) || Object.getPrototypeOf(events) !== Array.prototype || events.length > MAX_EVENTS
    || Reflect.ownKeys(events).length !== events.length + 1
    || Array.from({ length: events.length }, (_, index) => Object.getOwnPropertyDescriptor(events, String(index)))
      .some((descriptor) => descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value'))) fail('attribution_invalid');
  const records = events.map(snapshotEvent);
  const ids = new Set(), receipts = new Map(), groups = new Map(), totals = new Map();
  let from = null, to = null, leads = 0, sales = 0, unvaluedConversions = 0;
  for (const event of records) {
    if (ids.has(event.id)) fail('event_duplicate');
    ids.add(event.id);
    if (event.type === 'redemption') {
      if (receipts.has(event.receiptId)) fail('receipt_duplicate');
      receipts.set(event.receiptId, event);
    }
    if (from === null || event.occurredAt < from) from = event.occurredAt;
    if (to === null || event.occurredAt > to) to = event.occurredAt;
  }
  for (const event of records) {
    const key = campaignKey(event.campaign);
    if (!groups.has(key)) groups.set(key, { campaign: event.campaign, redemptions: 0, leads: 0, sales: 0 });
    const group = groups.get(key);
    if (event.type === 'redemption') { group.redemptions += 1; continue; }
    const receipt = receipts.get(event.receiptId);
    if (!receipt) fail('receipt_missing');
    if (receipt.linkId !== event.linkId || receipt.revisionId !== event.revisionId || campaignKey(receipt.campaign) !== key) fail('binding_mismatch');
    if (event.occurredAt < receipt.occurredAt) fail('event_order_invalid');
    if (event.conversion.kind === 'lead') { leads += 1; group.leads += 1; }
    else { sales += 1; group.sales += 1; }
    if (event.conversion.valueMinor === null) { unvaluedConversions += 1; continue; }
    const previous = totals.get(event.conversion.currency) ?? { currency: event.conversion.currency, valueMinor: 0, eventCount: 0 };
    const valueMinor = previous.valueMinor + event.conversion.valueMinor;
    if (!Number.isSafeInteger(valueMinor)) fail('total_overflow');
    totals.set(event.conversion.currency, { currency: event.conversion.currency, valueMinor, eventCount: previous.eventCount + 1 });
  }
  return Object.freeze({ provenance: 'supplied_events', coverage: 'supplied_records_only', recordCount: records.length,
    redemptions: receipts.size, conversions: Object.freeze({ lead: leads, sale: sales }), unvaluedConversions,
    currencyTotals: Object.freeze([...totals.values()].sort((a, b) => compareText(a.currency, b.currency)).map(Object.freeze)),
    campaigns: Object.freeze([...groups.entries()].sort(([a], [b]) => compareText(a, b)).map(([, group]) => Object.freeze(group))),
    period: Object.freeze({ from, to }) });
}
