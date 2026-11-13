import type { Change, ChangeRecord, Config, Decision, Identity, Pharmacy, Review, Scope, Submission } from './contracts.ts';
import { emailAddress } from './normalize.ts';
import { active } from './time.ts';

export type Snapshot = { pharmacies: Pharmacy[]; preferences: ChangeRecord[]; appliedChangeIds: string[]; reviews: Review[] };
export class Store {
  config: Config;
  pharmacyApi: string;
  changes: ChangeRecord[] = [];
  reviews: Review[] = [];
  submissions = new Map<string, Submission>();
  decisions: Decision[] = [];
  sequence = 0;
  constructor(config: Config, pharmacyApi: string) { this.config = config; this.pharmacyApi = pharmacyApi; }
  identity(from: string): Identity {
    const address = emailAddress(from);
    if (this.config.lumimedsOps.includes(address)) return { kind: 'ops' };
    const pharmacy = this.config.pharmacies.find(p => p.contacts.includes(address));
    return pharmacy ? { kind: 'pharmacy', pharmacyId: pharmacy.id } : { kind: 'unknown' };
  }
  snapshot(at: string, sequence = this.sequence): Snapshot {
    const pharmacies = structuredClone(this.config.pharmacies);
    const preferences: ChangeRecord[] = [];
    const appliedChangeIds: string[] = [];
    for (const record of this.changes) {
      if (record.sequence > sequence || Date.parse(record.receivedAt) > Date.parse(at)) continue;
      if (record.withdrawnAt && Date.parse(record.withdrawnAt) <= Date.parse(at) && (record.withdrawnSequence ?? 0) <= sequence) continue;
      const change = record.change;
      if (!active(change.effectiveFrom, change.effectiveUntil, at)) continue;
      appliedChangeIds.push(record.changeId);
      if (change.op === 'routing.prefer') { preferences.push(record); continue; }
      const pharmacy = pharmacies.find(p => p.id === change.pharmacyId)!;
      switch (change.op) {
        case 'open.set': pharmacy.open = change.open; break;
        case 'capacity.set': pharmacy.dailyCapacity = change.dailyCapacity; break;
        case 'shipping.set': pharmacy.shipsInDays = change.shipsInDays; break;
        case 'price.set': pharmacy.price[change.medication] = change.usd; break;
        case 'state.set': {
          pharmacy.blockedStates = pharmacy.blockedStates.filter(s => s !== change.state);
          if (change.blocked) pharmacy.blockedStates.push(change.state);
          break;
        }
        case 'stock.set': {
          const doses = (pharmacy.stock[change.medication] ?? []).filter(d => d !== change.dose);
          if (change.available) doses.push(change.dose);
          pharmacy.stock[change.medication] = doses;
          break;
        }
      }
    }
    const reviews = this.reviews.filter(review => review.sequence <= sequence && Date.parse(review.receivedAt) <= Date.parse(at)
      && review.hold && active(review.hold.from, review.hold.until, at)
      && (!review.hold.resolvedAt || Date.parse(review.hold.resolvedAt) > Date.parse(at) || (review.hold.resolvedSequence ?? 0) > sequence));
    return { pharmacies, preferences, appliedChangeIds, reviews };
  }
  capacityUsed(id: string, day: string): number {
    return [...this.submissions.values()].filter(s => s.target === id && s.dateET === day && s.status !== 'rejected').length;
  }
  addChanges(changes: Change[], eventId: string, at: string): void {
    for (const change of changes) {
      for (const id of change.supersedes) {
        const old = this.changes.find(c => c.changeId === id)!;
        old.withdrawnAt = at;
        old.withdrawnSequence = this.sequence;
      }
      this.changes.push({ changeId: `${eventId}:change:${this.changes.length + 1}`, sourceEventId: eventId, receivedAt: at, sequence: this.sequence, change });
    }
  }
  resolve(ids: string[], at: string): void {
    for (const id of ids) {
      const review = this.reviews.find(r => r.reviewId === id)!;
      review.status = 'resolved';
      if (review.hold) { review.hold.resolvedAt = at; review.hold.resolvedSequence = this.sequence; }
    }
  }
}
export function matchesScope(scope: Scope, pharmacyId: string, order: { medication: string; dose: string; state: string }): boolean {
  return (!scope.pharmacyId || scope.pharmacyId === pharmacyId) && (!scope.medication || scope.medication === order.medication)
    && (!scope.dose || scope.dose === order.dose) && (!scope.state || scope.state === order.state);
}
