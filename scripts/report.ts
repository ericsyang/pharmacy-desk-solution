export type RunReport = {
  run: number; events: number; orders: number; matched: number; passed: boolean;
  mismatches: { orderId: string; expected: string; actual: string | null }[];
  unexpectedOrders: string[]; duplicateOrders: string[]; deliveryErrors: number; error?: string;
};
export function compareRun(run: number, orders: Record<string, unknown>[], deliveries: Record<string, unknown>[], expected: Record<string, string>): RunReport {
  const actual = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const order of orders) {
    const id = String(order.order_id);
    if (actual.has(id)) duplicates.add(id);
    actual.set(id, String(order.pharmacy));
  }
  const mismatches = Object.entries(expected).filter(([id, target]) => actual.get(id) !== target)
    .map(([orderId, target]) => ({ orderId, expected: target, actual: actual.get(orderId) ?? null }));
  const unexpectedOrders = [...actual.keys()].filter(id => !Object.hasOwn(expected, id));
  const deliveryErrors = deliveries.filter(row => !(Number(row.status) >= 200 && Number(row.status) < 300)).length;
  return { run, events: deliveries.length, orders: orders.length, matched: Object.keys(expected).length - mismatches.length,
    passed: orders.length === Object.keys(expected).length && mismatches.length === 0 && !duplicates.size && !unexpectedOrders.length && deliveries.length > 0 && !deliveryErrors,
    mismatches, unexpectedOrders, duplicateOrders: [...duplicates], deliveryErrors };
}
