import { changeSchema, type Change, type EmailEvent, type Identity, type Scope } from './contracts.ts';
import { doseName, fingerprint, medicationName, stateCode } from './normalize.ts';
import { Store } from './store.ts';
import { validateWindow } from './time.ts';

export class ReviewError extends Error {
  code: string;
  safety: boolean;
  scope?: Scope;
  constructor(code: string, detail: string, safety = false, scope?: Scope) {
    super(detail); this.code = code; this.safety = safety; this.scope = scope;
  }
}
export const isSafetyChange = (change: Change): boolean => ['stock.set', 'state.set', 'open.set', 'capacity.set'].includes(change.op);
export function changeScope(change: Change): Scope {
  return { pharmacyId: change.pharmacyId,
    ...(change.op === 'stock.set' ? { medication: change.medication, dose: change.dose } : {}),
    ...(change.op === 'state.set' ? { state: change.state } : {}),
  };
}
export function boundedScope(identity: Identity, scope?: Scope): Scope | undefined {
  if (identity.kind === 'unknown') return undefined;
  if (identity.kind === 'pharmacy' && scope?.pharmacyId && scope.pharmacyId !== identity.pharmacyId) return undefined;
  return { ...(scope ?? {}), ...(identity.kind === 'pharmacy' ? { pharmacyId: identity.pharmacyId } : {}) };
}
export function validateChange(raw: unknown, event: EmailEvent, store: Store, identity: Identity): Change {
  if (identity.kind === 'unknown') throw new ReviewError('UNAUTHORIZED', 'Unknown sender');
  if (identity.kind === 'pharmacy' && raw && typeof raw === 'object') {
    if (('pharmacyId' in raw && raw.pharmacyId !== identity.pharmacyId) || ('op' in raw && raw.op === 'routing.prefer')) {
      throw new ReviewError('UNAUTHORIZED', 'Sender cannot make this change');
    }
  }
  const parsed = changeSchema.safeParse(raw);
  if (!parsed.success) {
    const op = raw && typeof raw === 'object' && 'op' in raw ? String(raw.op) : '';
    throw new ReviewError('INVALID_VALUE', `${op}: Invalid change structure`, ['stock.set', 'state.set', 'open.set', 'capacity.set'].includes(op));
  }
  const change = parsed.data;
  const target = store.config.pharmacies.find(p => p.id === change.pharmacyId);
  if (identity.kind === 'pharmacy' && (change.pharmacyId !== identity.pharmacyId || change.op === 'routing.prefer')) {
    throw new ReviewError('UNAUTHORIZED', 'Sender cannot make this change');
  }
  if (!target) throw new ReviewError('INVALID_VALUE', 'Unknown pharmacy');
  const original = `${event.email.subject}\n${event.email.body}`;
  if (!original.includes(change.evidence)) throw new ReviewError('INVALID_VALUE', `${change.op}: Evidence must be copied from this email`, isSafetyChange(change), changeScope(change));
  if ('medication' in change) {
    change.medication = medicationName(change.medication);
    if (!store.config.catalogue[change.medication]) throw new ReviewError('INVALID_DOSE', 'Medication outside catalogue');
  }
  if (change.op === 'stock.set') {
    const dose = doseName(change.dose);
    if (!dose || !store.config.catalogue[change.medication]?.includes(dose)) throw new ReviewError('INVALID_DOSE', 'Dose outside catalogue; do not repair typos');
    change.dose = dose;
    const mentionedDoses = [...change.evidence.matchAll(/\b\d+(?:\.\d+)?\s*mg\b/gi)].map(m => doseName(m[0]));
    if (!mentionedDoses.includes(dose)) throw new ReviewError('INVALID_DOSE', 'Evidence does not contain the proposed exact dose');
  }
  if (change.op === 'state.set') {
    const state = stateCode(change.state);
    if (!state) throw new ReviewError('INVALID_VALUE', 'Unknown state');
    change.state = state;
  }
  if (change.op === 'routing.prefer') {
    const match = change.match;
    if (match.medication) {
      match.medication = medicationName(match.medication);
      if (!store.config.catalogue[match.medication]) throw new ReviewError('INVALID_VALUE', 'Unknown routing medication');
    }
    if (match.dose) {
      const dose = doseName(match.dose);
      if (!dose || !(match.medication ? store.config.catalogue[match.medication] : Object.values(store.config.catalogue).flat())?.includes(dose)) throw new ReviewError('INVALID_DOSE', 'Unknown routing dose');
      match.dose = dose;
    }
    if (match.state) {
      const state = stateCode(match.state);
      if (!state) throw new ReviewError('INVALID_VALUE', 'Unknown routing state');
      match.state = state;
    }
  }
  try { validateWindow(change, event.occurred_at, original); }
  catch (error) { throw new ReviewError('AMBIGUOUS_TIME', `${change.op}: ${error instanceof Error ? error.message : 'Invalid time'}`, isSafetyChange(change), changeScope(change)); }
  for (const id of change.supersedes) {
    const prior = store.changes.find(c => c.changeId === id);
    const routingCorrection = prior?.change.op === 'routing.prefer' && change.op === 'routing.prefer'
      && fingerprint(prior.change.match) === fingerprint(change.match);
    if (!prior || prior.withdrawnAt || (!routingCorrection && prior.change.pharmacyId !== change.pharmacyId) || prior.change.op !== change.op
      || ('medication' in prior.change && 'medication' in change && prior.change.medication !== change.medication)) {
      throw new ReviewError('CONFLICT', 'Correction must reference an existing change in the same authority and field scope', isSafetyChange(change), changeScope(change));
    }
    if (!/correct|instead|not|replace|withdraw|cancel|retract/i.test(event.email.body)) throw new ReviewError('CONFLICT', 'Correction has no supporting wording', isSafetyChange(change), changeScope(change));
  }
  return change;
}
export function changeField(change: Change): string {
  return [change.op === 'routing.prefer' ? 'OPS' : change.pharmacyId, change.op,
    'medication' in change ? change.medication : '',
    'dose' in change ? change.dose : '',
    'state' in change ? change.state : '',
    change.op === 'routing.prefer' ? JSON.stringify(change.match) : '',
  ].join('|');
}
export function conflicting(a: Change, b: Change): boolean {
  if (changeField(a) !== changeField(b)) return false;
  const overlap = Date.parse(a.effectiveFrom) < (b.effectiveUntil === null ? Infinity : Date.parse(b.effectiveUntil))
    && Date.parse(b.effectiveFrom) < (a.effectiveUntil === null ? Infinity : Date.parse(a.effectiveUntil));
  const value = (c: Change): unknown => {
    switch (c.op) {
      case 'stock.set': return c.available;
      case 'state.set': return c.blocked;
      case 'open.set': return c.open;
      case 'capacity.set': return c.dailyCapacity;
      case 'shipping.set': return c.shipsInDays;
      case 'price.set': return c.usd;
      case 'routing.prefer': return c.pharmacyId;
    }
  };
  return overlap && value(a) !== value(b);
}
export function validateResolutions(ids: string[], changes: Change[], store: Store, identity: Identity): void {
  for (const id of ids) {
    const review = store.reviews.find(r => r.reviewId === id && r.status === 'pending');
    if (!review || identity.kind === 'unknown') throw new ReviewError('CONFLICT', 'Unknown or resolved review item');
    if (!review.hold) throw new ReviewError('CONFLICT', 'Only a clarification of a safety hold may resolve it automatically');
    const scope = review.hold.scope;
    if (identity.kind === 'pharmacy' && scope.pharmacyId !== identity.pharmacyId) throw new ReviewError('UNAUTHORIZED', 'Sender cannot resolve this review');
    // A single restock is not sufficient to clear a whole-pharmacy unknown-state hold.
    const covering = changes.some(change => change.pharmacyId === scope.pharmacyId && (
      scope.dose ? change.op === 'stock.set' && change.dose === scope.dose && change.medication === scope.medication
        : scope.state ? change.op === 'state.set' && change.state === scope.state
          : review.detail.startsWith('open.set:') ? change.op === 'open.set'
            : review.detail.startsWith('capacity.set:') ? change.op === 'capacity.set' : false
    ));
    if (!covering) throw new ReviewError('CONFLICT', 'Clarification must cover the entire held scope; broad unknown-state holds need manual investigation');
  }
}
