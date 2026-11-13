import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareRun } from '../scripts/report.ts';

test('report records delivery success separately from routing mismatch', () => {
  const report = compareRun(1, [{ order_id: 'O1', pharmacy: 'B' }, { order_id: 'O2', pharmacy: 'MANUAL' }], [{ status: 200 }, { status: 200 }], { O1: 'A', O2: 'MANUAL' });
  assert.equal(report.events, 2);
  assert.equal(report.matched, 1);
  assert.equal(report.passed, false);
  assert.equal(report.deliveryErrors, 0);
  assert.deepEqual(report.mismatches, [{ orderId: 'O1', expected: 'A', actual: 'B' }]);
});
test('report cannot hide duplicates, missing orders or failed deliveries', () => {
  const report = compareRun(1, [{ order_id: 'O1', pharmacy: 'A' }, { order_id: 'O1', pharmacy: 'A' }], [{ status: 502 }], { O1: 'A', O2: 'B' });
  assert.equal(report.passed, false);
  assert.deepEqual(report.duplicateOrders, ['O1']);
  assert.deepEqual(report.mismatches, [{ orderId: 'O2', expected: 'B', actual: null }]);
  assert.equal(report.deliveryErrors, 1);
});
