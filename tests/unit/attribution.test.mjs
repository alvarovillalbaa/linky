import test from 'node:test';
import assert from 'node:assert/strict';
import { AttributionError, summarizeAttribution } from '../../public/src/attribution.mjs';

const campaign = (overrides = {}) => ({ source: 'friends', medium: 'shared-link', campaign: 'authored', ...overrides });
const redemption = (overrides = {}) => ({ id: 'event-1', type: 'redemption', receiptId: 'receipt-1', linkId: 'link-1', revisionId: 'revision-1', campaign: campaign(), occurredAt: '2026-10-29T12:00:00.000Z', conversion: null, ...overrides });
const conversion = (overrides = {}) => ({ ...redemption(), id: 'event-2', type: 'conversion', occurredAt: '2026-10-29T12:01:00.000Z', conversion: { kind: 'lead', valueMinor: null, currency: null }, ...overrides });
const code = (expected) => (error) => error instanceof AttributionError && error.code === expected;

test('an empty batch reports supplied coverage with unknown observed period', () => {
  assert.deepEqual(summarizeAttribution([]), { provenance: 'supplied_events', coverage: 'supplied_records_only', recordCount: 0, redemptions: 0,
    conversions: { lead: 0, sale: 0 }, unvaluedConversions: 0, currencyTotals: [], campaigns: [], period: { from: null, to: null } });
});

test('redemption records count receipts without inventing people arrival or conversion', () => {
  const summary = summarizeAttribution([redemption()]);
  assert.equal(summary.recordCount, 1);
  assert.equal(summary.redemptions, 1);
  assert.deepEqual(summary.conversions, { lead: 0, sale: 0 });
  assert.deepEqual(summary.campaigns, [{ campaign: campaign(), redemptions: 1, leads: 0, sales: 0 }]);
  for (const invented of ['uniquePeople', 'arrivals', 'verifiedSales', 'conversionRate']) assert.equal(Object.hasOwn(summary, invented), false);
});

test('conversion order in the supplied array does not replace receipt bindings', () => {
  const summary = summarizeAttribution([conversion(), redemption()]);
  assert.equal(summary.redemptions, 1);
  assert.equal(summary.conversions.lead, 1);
  assert.equal(summary.unvaluedConversions, 1);
  assert.deepEqual(summary.period, { from: '2026-10-29T12:00:00.000Z', to: '2026-10-29T12:01:00.000Z' });
});

test('campaign dimensions remain distinct and deterministically ordered', () => {
  const first = redemption({ id: 'a', receiptId: 'a', campaign: campaign({ source: 'a', medium: 'b|c' }) });
  const second = redemption({ id: 'b', receiptId: 'b', campaign: campaign({ source: 'a|b', medium: 'c' }) });
  const third = redemption({ id: 'c', receiptId: 'c', campaign: campaign({ source: 'a', medium: 'b|c', campaign: 'other' }) });
  const forward = summarizeAttribution([first, second, third]);
  const reverse = summarizeAttribution([third, second, first]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.campaigns.length, 3);
  assert.ok(forward.campaigns.every((group) => group.redemptions === 1));
});

test('declared sale totals stay separated by currency and zero retains its meaning', () => {
  const summary = summarizeAttribution([redemption(),
    conversion({ id: 'usd', conversion: { kind: 'sale', valueMinor: 1200, currency: 'USD' } }),
    conversion({ id: 'eur', conversion: { kind: 'sale', valueMinor: 900, currency: 'EUR' } }),
    conversion({ id: 'zero', conversion: { kind: 'sale', valueMinor: 0, currency: 'USD' } }),
    conversion({ id: 'unknown', conversion: { kind: 'sale', valueMinor: null, currency: null } }),
    conversion({ id: 'lead' })]);
  assert.deepEqual(summary.currencyTotals, [{ currency: 'EUR', valueMinor: 900, eventCount: 1 }, { currency: 'USD', valueMinor: 1200, eventCount: 2 }]);
  assert.deepEqual(summary.conversions, { lead: 1, sale: 4 });
  assert.equal(summary.unvaluedConversions, 2);
  assert.equal(Object.hasOwn(summary, 'totalValueMinor'), false);
});

test('repeated or conflicting event IDs are rejected instead of double counted', () => {
  assert.throws(() => summarizeAttribution([redemption(), redemption()]), code('event_duplicate'));
  assert.throws(() => summarizeAttribution([redemption(), conversion({ id: 'event-1' })]), code('event_duplicate'));
});

test('a receipt cannot be supplied as two redemption events or different links', () => {
  assert.throws(() => summarizeAttribution([redemption(), redemption({ id: 'different' })]), code('receipt_duplicate'));
  assert.throws(() => summarizeAttribution([redemption(), redemption({ id: 'different', linkId: 'another' })]), code('receipt_duplicate'));
});

test('conversions require a supplied receipt with the same immutable campaign context', () => {
  assert.throws(() => summarizeAttribution([conversion()]), code('receipt_missing'));
  for (const overrides of [{ linkId: 'other' }, { revisionId: 'other' }, { campaign: campaign({ source: 'other' }) }]) assert.throws(() => summarizeAttribution([redemption(), conversion(overrides)]), code('binding_mismatch'));
});

test('conversion timestamps cannot precede their redemption', () => {
  assert.throws(() => summarizeAttribution([redemption(), conversion({ occurredAt: '2026-10-29T11:59:59.999Z' })]), code('event_order_invalid'));
  assert.equal(summarizeAttribution([redemption(), conversion({ occurredAt: '2026-10-29T12:00:00Z' })]).conversions.lead, 1);
});

test('event campaign and conversion shapes reject unknown missing or accessor fields', () => {
  for (const value of [redemption({ extra: 'private' }), redemption({ conversion: undefined }), redemption({ type: 'click' }), redemption({ campaign: { ...campaign(), private: true } }), conversion({ conversion: { kind: 'lead', valueMinor: null, currency: null, verified: true } })]) assert.throws(() => summarizeAttribution([value]), code('event_invalid'));
  const getter = { ...redemption() };
  Object.defineProperty(getter, 'id', { get() { throw new Error('must not be read'); }, enumerable: true });
  assert.throws(() => summarizeAttribution([getter]), code('event_invalid'));
  for (const [target, key] of [['event', 'id'], ['campaign', 'source'], ['conversion', 'kind']]) {
    for (const descriptor of [{ set() { throw new Error('must not be called'); }, enumerable: true }, { value: 'hidden', enumerable: false }]) {
      const input = conversion();
      Object.defineProperty(target === 'event' ? input : input[target], key, descriptor);
      assert.throws(() => summarizeAttribution([input]), code('event_invalid'));
    }
  }
});

test('amounts require exact nonnegative integers and paired currency with unvalued leads', () => {
  for (const supplied of [
    { kind: 'sale', valueMinor: true, currency: 'USD' }, { kind: 'sale', valueMinor: -1, currency: 'USD' },
    { kind: 'sale', valueMinor: 1.5, currency: 'USD' }, { kind: 'sale', valueMinor: Infinity, currency: 'USD' },
    { kind: 'sale', valueMinor: NaN, currency: 'USD' }, { kind: 'sale', valueMinor: 1, currency: 'usd' },
    { kind: 'sale', valueMinor: null, currency: 'USD' }, { kind: 'sale', valueMinor: 1, currency: null },
    { kind: 'lead', valueMinor: 1, currency: 'USD' }, { kind: 'purchase', valueMinor: null, currency: null },
  ]) assert.throws(() => summarizeAttribution([redemption(), conversion({ conversion: supplied })]), code('event_invalid'));
});

test('timestamps validate real calendar dates and retain normalized observed UTC bounds', () => {
  for (const occurredAt of ['2026-02-30T12:00:00Z', '0000-01-01T00:00:00Z', '9999-12-31T23:59:59-01:00', '2026-10-29', '2026-10-29T12:00:00', '2026-10-29T24:00:00Z', '2026-10-29T12:00:60Z', '2026-10-29T12:00:00+25:00']) assert.throws(() => summarizeAttribution([redemption({ occurredAt })]), code('event_invalid'));
  const summary = summarizeAttribution([redemption({ occurredAt: '2026-10-29T14:00:00+02:00' }), conversion()]);
  assert.equal(summary.period.from, '2026-10-29T12:00:00.000Z');
});

test('campaign text and event identities are bounded without losing valid Unicode', () => {
  assert.equal(summarizeAttribution([redemption({ campaign: campaign({ source: '🌍'.repeat(50) }) })]).campaigns[0].campaign.source, '🌍'.repeat(50));
  for (const source of ['x'.repeat(101), '\ud800', '\udfff', 'bad\u0000text', 'bad\ntext']) assert.throws(() => summarizeAttribution([redemption({ campaign: campaign({ source }) })]), code('event_invalid'));
  for (const id of ['', 'space id', 'x'.repeat(129), true, null]) assert.throws(() => summarizeAttribution([redemption({ id })]), code('event_invalid'));
});

test('batch bounds reject sparse accessors extra properties and oversized inventories', () => {
  assert.throws(() => summarizeAttribution(Array(1)), code('attribution_invalid'));
  const accessor = [];
  Object.defineProperty(accessor, '0', { get() { throw new Error('must not be read'); }, enumerable: true });
  assert.throws(() => summarizeAttribution(accessor), code('attribution_invalid'));
  const extra = [redemption()]; extra.extra = true;
  assert.throws(() => summarizeAttribution(extra), code('attribution_invalid'));
  const hidden = [];
  Object.defineProperty(hidden, '0', { value: redemption(), enumerable: false });
  assert.throws(() => summarizeAttribution(hidden), code('attribution_invalid'));
  class PrivateArray extends Array { map() { throw new Error('must not call caller code'); } }
  assert.throws(() => summarizeAttribution(new PrivateArray(redemption())), code('attribution_invalid'));
  const changedPrototype = [redemption()];
  Object.setPrototypeOf(changedPrototype, { map() { throw new Error('must not call caller code'); } });
  assert.throws(() => summarizeAttribution(changedPrototype), code('attribution_invalid'));
  assert.throws(() => summarizeAttribution(Array(10_001).fill(redemption())), code('attribution_invalid'));
  assert.equal(summarizeAttribution(Array.from({ length: 10_000 }, (_, index) => redemption({ id: `e${index}`, receiptId: `r${index}` }))).redemptions, 10_000);
});

test('currency arithmetic rejects overflow instead of rounding declared values', () => {
  assert.throws(() => summarizeAttribution([redemption(), conversion({ id: 'large', conversion: { kind: 'sale', valueMinor: Number.MAX_SAFE_INTEGER, currency: 'USD' } }), conversion({ id: 'extra', conversion: { kind: 'sale', valueMinor: 1, currency: 'USD' } })]), code('total_overflow'));
  assert.equal(summarizeAttribution([redemption(), conversion({ conversion: { kind: 'sale', valueMinor: Number.MAX_SAFE_INTEGER, currency: 'USD' } })]).currencyTotals[0].valueMinor, Number.MAX_SAFE_INTEGER);
});

test('summaries detach and freeze every returned campaign total and count', () => {
  const input = redemption();
  const summary = summarizeAttribution([input, conversion({ conversion: { kind: 'sale', valueMinor: 20, currency: 'EUR' } })]);
  input.campaign.source = 'changed';
  assert.equal(summary.campaigns[0].campaign.source, 'friends');
  assert.ok(Object.isFrozen(summary) && Object.isFrozen(summary.period) && Object.isFrozen(summary.conversions));
  assert.ok(Object.isFrozen(summary.campaigns) && Object.isFrozen(summary.campaigns[0]) && Object.isFrozen(summary.campaigns[0].campaign));
  assert.ok(Object.isFrozen(summary.currencyTotals) && Object.isFrozen(summary.currencyTotals[0]));
  assert.throws(() => { summary.campaigns[0].redemptions = 900; }, TypeError);
});
