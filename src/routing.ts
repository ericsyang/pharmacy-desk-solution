import type { Decision, Order } from './contracts.ts';
import { doseName, medicationName, stateCode } from './normalize.ts';
import { matchesScope, type Snapshot } from './store.ts';

export function route(order: Order, at: string, snapshot: Snapshot, capacity: (pharmacyId: string) => number, catalogue: Record<string, string[]>): Decision {
  const drug = medicationName(order.medication);
  const dose = doseName(order.dose);
  const state = stateCode(order.state);
  const exclusions: Record<string, string[]> = {};
  const normalized = { medication: drug, dose: dose ?? '', state: state ?? '' };
  const validInput = Boolean(state && dose && catalogue[drug]?.includes(dose));
  const candidates = snapshot.pharmacies.filter(p => {
    const reasons: string[] = [];
    if (!validInput) reasons.push('INVALID_ORDER: unknown state, medication or dose');
    if (!p.open) reasons.push('CLOSED');
    if (state && p.blockedStates.includes(state)) reasons.push('STATE_BLOCKED');
    if (!dose || !p.stock[drug]?.includes(dose)) reasons.push('DOSE_UNAVAILABLE');
    if (capacity(p.id) >= p.dailyCapacity) reasons.push('CAPACITY_FULL');
    if (p.price[drug] === undefined) reasons.push('PRICE_UNKNOWN');
    for (const review of snapshot.reviews) {
      if (review.hold && matchesScope(review.hold.scope, p.id, normalized)) reasons.push(`SAFETY_UNKNOWN:${review.reviewId}`);
    }
    if (reasons.length) exclusions[p.id] = reasons;
    return reasons.length === 0;
  }).sort((a, b) => a.shipsInDays - b.shipsInDays || a.price[drug]! - b.price[drug]! || a.id.localeCompare(b.id));
  const preference = [...snapshot.preferences].reverse().find(record => {
    if (record.change.op !== 'routing.prefer') return false;
    const match = record.change.match;
    return (!match.medication || match.medication === drug) && (!match.dose || match.dose === dose) && (!match.state || match.state === state);
  });
  const preferred = preference ? candidates.find(p => p.id === preference.change.pharmacyId) : undefined;
  const selected = preferred ?? candidates[0];
  let reason = !selected ? 'No safely eligible pharmacy' : preferred ? `Ops preference ${preference!.changeId}` : 'Fastest delivery, then lowest medication price, then pharmacy ID';
  if (preference && !preferred && selected) reason += `; ops target ${preference.change.pharmacyId} ineligible: ${(exclusions[preference.change.pharmacyId] ?? []).join(', ')}`;
  if (!validInput) reason = 'Invalid order business values; manual review required';
  return { orderId: order.order_id, eventTime: at, candidates: candidates.map(p => p.id), exclusions, appliedChangeIds: snapshot.appliedChangeIds, selected: selected?.id ?? 'MANUAL', reason };
}
