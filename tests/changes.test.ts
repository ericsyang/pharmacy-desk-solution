import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateChange, validateResolutions } from '../src/changes.ts';
import { Store } from '../src/store.ts';
import { change, config, email, monday } from './helpers.ts';

test('a correction cannot withdraw another pharmacy record or reference a nonexistent record', () => {
  const store = new Store(config(), 'http://localhost:4000');
  store.addChanges([change({ pharmacyId: 'B' })], 'old', monday);
  const corrected = change({ open: true, evidence: 'Correction: We are open', supersedes: [store.changes[0]!.changeId] });
  assert.throws(() => validateChange(corrected, email('Correction: We are open'), store, { kind: 'pharmacy', pharmacyId: 'A' }), /same authority/);
  assert.throws(() => validateChange({ ...corrected, supersedes: ['nonexistent'] }, email('Correction: We are open'), store, { kind: 'ops' }), /same authority/);
});
test('unsupported time cannot be accepted merely because the model emits a legal ISO date', () => {
  const store = new Store(config(), 'http://localhost:4000');
  assert.throws(() => validateChange(change({ timeText: 'sometime next week', evidence: 'We are closed sometime next week' }), email('We are closed sometime next week'), store, { kind: 'pharmacy', pharmacyId: 'A' }), /Unsupported/);
});
test('raw evidence must come from the email and contain the exact stock dose', () => {
  const store = new Store(config(), 'http://localhost:4000');
  assert.throws(() => validateChange(change({ evidence: 'Invented source' }), email(), store, { kind: 'ops' }), /Evidence/);
  assert.throws(() => validateChange(change({ op: 'stock.set', medication: 'tirzepatide', dose: '2.5mg', available: true, evidence: 'Restocked tirz 25mg' }), email('Restocked tirz 25mg'), store, { kind: 'pharmacy', pharmacyId: 'A' }), /exact dose/);
});
test('a stock update cannot clear a whole-pharmacy model-failure hold', () => {
  const store = new Store(config(), 'http://localhost:4000');
  store.reviews.push({ reviewId: 'R1', eventId: 'E1', receivedAt: monday, sequence: 0, sender: 'a@pharmacy.example', email: email().email, reasonCode: 'LLM_FAILURE', detail: 'Unknown safety state', status: 'pending', hold: { scope: { pharmacyId: 'A' }, from: monday, until: null } });
  const proposed = change({ op: 'stock.set', medication: 'tirzepatide', dose: '5mg', available: true });
  assert.throws(() => validateResolutions(['R1'], [proposed], store, { kind: 'pharmacy', pharmacyId: 'A' }), /entire held scope/);
});

test('ops may correct the target of its own matching routing instruction', () => {
  const store = new Store(config(), 'http://localhost:4000');
  store.addChanges([change({ op: 'routing.prefer', pharmacyId: 'A', match: {} })], 'old', monday);
  const proposed = change({ op: 'routing.prefer', pharmacyId: 'B', match: {}, evidence: 'Correction: route to B instead of A', supersedes: [store.changes[0]!.changeId] });
  assert.equal(validateChange(proposed, email('Correction: route to B instead of A', 'sam@lumimeds.example'), store, { kind: 'ops' }).pharmacyId, 'B');
});
