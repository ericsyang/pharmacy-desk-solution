import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doseName, emailAddress, fingerprint, stateCode } from '../src/normalize.ts';
import { route } from '../src/routing.ts';
import { Store } from '../src/store.ts';
import { dateET, midnightET, validateWindow } from '../src/time.ts';
import { change, config, monday } from './helpers.ts';

const order = { order_id: 'O1', state: 'NY', medication: 'semaglutide', dose: '1mg' };
const decide = (store: Store, input = order, at = monday) => route(input, at, store.snapshot(at), id => store.capacityUsed(id, dateET(at)), store.config.catalogue);

test('state normalization preserves Texas/TX identity; only blocked pharmacy is excluded', () => {
  assert.equal(stateCode(' Texas '), 'TX');
  assert.equal(stateCode('tx'), 'TX');
  assert.equal(stateCode('New York'), 'NY');
  assert.equal(stateCode('unknown'), undefined);
  const result = decide(new Store(config(), 'http://localhost:4000'), { ...order, state: 'Texas' });
  assert.equal(result.selected, 'C');
  assert.ok(result.exclusions.A?.includes('STATE_BLOCKED'));
});
test('dose formatting is normalized without repairing decimal errors', () => {
  assert.equal(doseName(' 2.50 mg '), '2.5mg');
  assert.equal(doseName('25mg'), '25mg');
  assert.equal(doseName('2,5mg'), undefined);
  assert.equal(emailAddress(' SAM@LUMIMEDS.EXAMPLE '), 'sam@lumimeds.example');
});
test('fastest wins before price, price breaks speed ties, ID breaks equal ties', () => {
  const store = new Store(config(), 'http://localhost:4000');
  assert.equal(decide(store).selected, 'A');
  store.config.pharmacies[2]!.price.semaglutide = 130;
  assert.equal(decide(store).selected, 'C');
  store.config.pharmacies[2]!.price.semaglutide = 140;
  assert.equal(decide(store).selected, 'A');
});
test('exact dose, closure and capacity are hard constraints', () => {
  const store = new Store(config(), 'http://localhost:4000');
  store.config.pharmacies[0]!.open = false;
  store.config.pharmacies[2]!.stock.semaglutide = ['0.5mg'];
  assert.equal(decide(store).selected, 'B');
  for (let i = 0; i < 3; i++) store.submissions.set(String(i), { orderId: String(i), fingerprint: '', target: 'B', dateET: '2026-11-09', status: i === 0 ? 'unknown' : 'confirmed' });
  assert.equal(decide(store).selected, 'MANUAL');
  assert.equal(decide(store, order, '2026-11-10T08:00:00-05:00').selected, 'B');
});
test('capacity is shared across medications; rejected submissions release reservations', () => {
  const store = new Store(config(), 'http://localhost:4000');
  for (let i = 0; i < 2; i++) store.submissions.set(String(i), { orderId: String(i), fingerprint: '', target: 'A', dateET: '2026-11-09', status: 'pending' });
  assert.equal(decide(store, { ...order, medication: 'tirzepatide', dose: '5mg' }).selected, 'C');
  store.submissions.get('0')!.status = 'rejected';
  assert.equal(decide(store).selected, 'A');
});
test('operational preference outranks speed but cannot override safety', () => {
  const store = new Store(config(), 'http://localhost:4000');
  store.addChanges([change({ op: 'routing.prefer', pharmacyId: 'B', match: { medication: 'semaglutide' } })], 'ops', monday);
  assert.equal(decide(store).selected, 'B');
  assert.equal(decide(store, { ...order, state: 'CA' }).selected, 'A');
  assert.match(decide(store, { ...order, state: 'CA' }).reason, /ops target B ineligible/);
});
test('latest matching ops directive replaces earlier one even if latest target is unsafe', () => {
  const store = new Store(config(), 'http://localhost:4000');
  store.addChanges([change({ op: 'routing.prefer', pharmacyId: 'C', match: {} })], 'old', monday);
  store.addChanges([change({ op: 'routing.prefer', pharmacyId: 'B', match: {} })], 'new', monday);
  assert.equal(decide(store, { ...order, state: 'CA' }).selected, 'A');
});
test('future closure applies only on its day and baseline returns at exclusive end', () => {
  const store = new Store(config(), 'http://localhost:4000');
  store.addChanges([change({ effectiveFrom: '2026-11-10T00:00:00-05:00', effectiveUntil: '2026-11-11T00:00:00-05:00' })], 'future', monday);
  assert.equal(decide(store).selected, 'A');
  assert.equal(decide(store, order, '2026-11-10T09:00:00-05:00').selected, 'C');
  assert.equal(decide(store, order, '2026-11-11T00:00:00-05:00').selected, 'A');
});
test('temporary overlap restores older active state and corrections do not alter past snapshots', () => {
  const store = new Store(config(), 'http://localhost:4000');
  store.sequence = 1;
  store.addChanges([change()], 'closed', monday);
  store.sequence = 2;
  store.addChanges([change({ open: true, effectiveFrom: '2026-11-09T10:00:00-05:00', effectiveUntil: '2026-11-09T11:00:00-05:00' })], 'temporary', '2026-11-09T09:00:00-05:00');
  assert.equal(decide(store, order, '2026-11-09T10:30:00-05:00').selected, 'A');
  assert.equal(decide(store, order, '2026-11-09T11:00:00-05:00').selected, 'C');
  const originalId = store.changes[0]!.changeId;
  store.sequence = 3;
  store.addChanges([change({ open: true, effectiveFrom: '2026-11-09T12:00:00-05:00', supersedes: [originalId] })], 'correction', '2026-11-09T12:00:00-05:00');
  assert.equal(decide(store, order, '2026-11-09T08:30:00-05:00').selected, 'C');
  assert.equal(decide(store, order, '2026-11-09T12:00:00-05:00').selected, 'A');
});
test('late-arriving backdated facts never enter earlier snapshots', () => {
  const store = new Store(config(), 'http://localhost:4000');
  store.addChanges([change()], 'late', '2026-11-09T12:00:00-05:00');
  assert.equal(decide(store, order, '2026-11-09T09:00:00-05:00').selected, 'A');
  assert.equal(decide(store, order, '2026-11-09T12:01:00-05:00').selected, 'C');
});
test('a scoped safety hold excludes only affected orders and expires at known end', () => {
  const store = new Store(config(), 'http://localhost:4000');
  store.reviews.push({ reviewId: 'R1', eventId: 'E1', receivedAt: monday, sequence: 0, sender: 'a@pharmacy.example', email: { from: 'a@pharmacy.example', subject: '', body: '' }, reasonCode: 'AMBIGUOUS_TIME', detail: 'Shortage uncertain', status: 'pending', hold: { scope: { pharmacyId: 'A', medication: 'semaglutide', dose: '1mg' }, from: monday, until: '2026-11-10T00:00:00-05:00' } });
  assert.equal(decide(store).selected, 'C');
  assert.equal(decide(store, { ...order, dose: '0.5mg' }).selected, 'A');
  assert.equal(decide(store, order, '2026-11-10T00:00:00-05:00').selected, 'A');
});
test('unknown order values cannot be turned into guessed valid doses', () => {
  for (const input of [{ ...order, state: 'XX' }, { ...order, medication: 'unknown' }, { ...order, dose: '25mg' }]) assert.equal(decide(new Store(config(), 'http://localhost:4000'), input).selected, 'MANUAL');
});
test('ET date and midnight account for timezone and DST boundaries', () => {
  assert.equal(dateET('2026-11-10T02:00:00Z'), '2026-11-09');
  assert.equal(midnightET('2026-11-01'), '2026-11-01T04:00:00.000Z');
  assert.equal(midnightET('2026-11-02'), '2026-11-02T05:00:00.000Z');
});
test('relative schedules enforce declared start, end and one-day closure', () => {
  validateWindow(change({ timeText: 'tomorrow', effectiveFrom: '2026-11-10T00:00:00-05:00', effectiveUntil: '2026-11-11T00:00:00-05:00' }), monday, 'We are closed tomorrow');
  validateWindow(change({ op: 'stock.set', medication: 'tirzepatide', dose: '5mg', available: false, timeText: 'until Wednesday', effectiveUntil: '2026-11-11T00:00:00-05:00' }), monday, 'Out until Wednesday');
  validateWindow(change({ op: 'routing.prefer', pharmacyId: 'B', match: {}, timeText: 'from tomorrow for the rest of the week', effectiveFrom: '2026-11-10T00:00:00-05:00', effectiveUntil: '2026-11-16T00:00:00-05:00' }), monday, 'Route from tomorrow for the rest of the week');
  assert.throws(() => validateWindow(change({ timeText: 'tomorrow' }), monday, 'We are closed tomorrow'), /disagree/);
  assert.throws(() => validateWindow(change({ timeText: 'maybe next week' }), monday, 'maybe next week'), /ambiguous/);
});
test('fingerprints ignore object key order without changing array ordering', () => {
  assert.equal(fingerprint({ b: 1, a: 2 }), fingerprint({ a: 2, b: 1 }));
  assert.notEqual(fingerprint([1, 2]), fingerprint([2, 1]));
});

test('a backdated uncertainty hold cannot contaminate earlier snapshots', () => {
  const store = new Store(config(), 'http://localhost:4000');
  store.sequence = 2;
  store.reviews.push({ reviewId: 'R', eventId: 'late', receivedAt: '2026-11-09T12:00:00-05:00', sequence: 2, sender: 'a@pharmacy.example', email: { from: 'a@pharmacy.example', subject: '', body: '' }, reasonCode: 'CONFLICT', detail: 'Uncertain closure', status: 'pending', hold: { scope: { pharmacyId: 'A' }, from: monday, until: null } });
  assert.equal(decide(store, order, '2026-11-09T09:00:00-05:00').selected, 'A');
  assert.equal(decide(store, order, '2026-11-09T12:01:00-05:00').selected, 'C');
});
