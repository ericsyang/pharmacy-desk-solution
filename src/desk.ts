import { eventSchema, extractionSchema, normalizeConfig, type Change, type DeskEvent, type EmailEvent, type Identity, type Review, type Scope } from './contracts.ts';
import { boundedScope, changeScope, conflicting, isSafetyChange, ReviewError, validateChange, validateResolutions } from './changes.ts';
import type { Audit } from './audit.ts';
import type { EmailExtractor } from './email.ts';
import { ModelExtractionError } from './email.ts';
import { DeskError, message } from './errors.ts';
import { doseName, emailAddress, fingerprint, medicationName, stateCode } from './normalize.ts';
import type { PharmacyClient } from './pharmacy.ts';
import { route } from './routing.ts';
import { Store } from './store.ts';
import { dateET } from './time.ts';

type Reply = { status: number; body: { status: 'processed' | 'duplicate' } | { error: string } };
type Receipt = { fingerprint: string; reply: Reply };
export class Desk {
  store?: Store;
  private extractor: EmailExtractor;
  private pharmacy: PharmacyClient;
  private audit: Audit;
  private timeoutMs: number;
  private queue: Promise<void> = Promise.resolve();
  private receipts = new Map<string, Receipt>();
  private lastTime = -Infinity;
  private startFingerprint?: string;
  constructor(options: { extractor: EmailExtractor; pharmacy: PharmacyClient; audit: Audit; timeoutMs?: number }) {
    this.extractor = options.extractor; this.pharmacy = options.pharmacy; this.audit = options.audit; this.timeoutMs = options.timeoutMs ?? 25_000;
  }
  handle(raw: unknown, headers: { eventId?: string; simTime?: string } = {}): Promise<Reply> {
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) return Promise.resolve({ status: 400, body: { error: 'Invalid event payload' } });
    const event = parsed.data;
    if ((headers.eventId !== undefined && headers.eventId !== event.event_id) || (headers.simTime !== undefined && headers.simTime !== event.occurred_at)) {
      return Promise.resolve({ status: 400, body: { error: 'Event headers do not match body' } });
    }
    const task = this.queue.then(() => this.process(event));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
  private async process(event: DeskEvent): Promise<Reply> {
    const hash = fingerprint(event);
    if (event.type === 'simulation.started' && this.startFingerprint === hash) {
      const old = this.receipts.get(event.event_id);
      return old?.reply.status === 200 ? duplicate() : old?.reply ?? duplicate();
    }
    if (event.type !== 'simulation.started') {
      const receipt = this.receipts.get(event.event_id);
      if (receipt) {
        if (receipt.fingerprint !== hash) return failure(409, 'Event ID reused with different contents');
        return receipt.reply.status === 200 ? duplicate() : receipt.reply;
      }
      if (!this.store) return failure(409, 'Simulation not initialized');
      if (Date.parse(event.occurred_at) < this.lastTime) return failure(409, 'First-delivery time moved backwards');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Event processing deadline exceeded')), this.timeoutMs);
    let reply: Reply;
    try {
      if (event.type === 'simulation.started') {
        const url = new URL(event.pharmacyApi);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new DeskError(400, 'Invalid pharmacy API URL');
        let config;
        try { config = normalizeConfig(event.config); }
        catch (error) { throw new DeskError(400, message(error)); }
        await this.audit.reset();
        this.store = new Store(config, event.pharmacyApi);
        this.receipts.clear();
        this.lastTime = Date.parse(event.occurred_at);
        this.startFingerprint = hash;
      } else {
        const store = this.store!;
        store.sequence++;
        this.lastTime = Date.parse(event.occurred_at);
        if (event.type === 'email') await this.email(event, store, controller.signal);
        else await this.order(event, store, controller.signal);
      }
      reply = { status: 200, body: { status: 'processed' } };
    } catch (error) {
      reply = failure(error instanceof DeskError ? error.status : 500, error instanceof DeskError ? error.message : 'Internal processing or audit failure');
    } finally { clearTimeout(timer); }
    this.receipts.set(event.event_id, { fingerprint: hash, reply });
    return reply;
  }
  private addReview(event: EmailEvent, store: Store, identity: Identity, code: string, detail: string,
    safety = false, scope?: Scope, window?: { from: string; until: string | null }): void {
    const review: Review = { reviewId: `${event.event_id}:review:${store.reviews.length + 1}`, eventId: event.event_id, receivedAt: event.occurred_at, sequence: store.sequence,
      sender: emailAddress(event.email.from), email: event.email, reasonCode: code, detail, status: 'pending' };
    let bounded = boundedScope(identity, scope);
    if (bounded && safety) {
      // Invalid semantic values cannot silently narrow an uncertainty hold into an empty match.
      if (bounded.pharmacyId && !store.config.pharmacies.some(p => p.id === bounded!.pharmacyId)) bounded = boundedScope(identity);
      if (bounded?.medication) {
        const drug = medicationName(bounded.medication);
        if (!store.config.catalogue[drug]) bounded = { pharmacyId: bounded.pharmacyId };
        else bounded.medication = drug;
      }
      if (bounded?.state) {
        const state = stateCode(bounded.state);
        if (!state) bounded = { pharmacyId: bounded.pharmacyId };
        else bounded.state = state;
      }
      if (bounded?.dose) {
        const dose = doseName(bounded.dose);
        if (!dose || !bounded.medication || !store.config.catalogue[bounded.medication]?.includes(dose)) bounded = { pharmacyId: bounded.pharmacyId };
        else bounded.dose = dose;
      }
      if (bounded) review.hold = { scope: bounded, from: window?.from ?? event.occurred_at, until: window?.until ?? null };
    }
    store.reviews.push(review);
  }
  private async email(event: EmailEvent, store: Store, signal: AbortSignal): Promise<void> {
    const identity = store.identity(event.email.from);
    if (identity.kind === 'unknown') {
      this.addReview(event, store, identity, 'UNAUTHORIZED', 'Unknown sender; no changes applied');
    } else {
      let extracted;
      try {
        extracted = extractionSchema.parse(await abortable(this.extractor.extract(event, store, signal), signal));
        signal.throwIfAborted();
      } catch (error) {
        this.addReview(event, store, identity, 'LLM_FAILURE', error instanceof ModelExtractionError ? error.message : 'Email could not be safely interpreted', true);
      }
      const conflicts = new Set<number>();
      const proposals: { index: number; change: Change }[] = [];
      extracted?.groups.forEach((group, index) => {
        for (const raw of group.changes) {
          try { proposals.push({ index, change: validateChange(raw, event, store, identity) }); } catch { /* handled below per group */ }
        }
      });
      for (let i = 0; i < proposals.length; i++) for (let j = i + 1; j < proposals.length; j++) {
        if (conflicting(proposals[i]!.change, proposals[j]!.change)) { conflicts.add(proposals[i]!.index); conflicts.add(proposals[j]!.index); }
      }
      if (extracted) for (const [index, group] of extracted.groups.entries()) {
        try {
          const changes = group.changes.map(raw => validateChange(raw, event, store, identity));
          if (conflicts.has(index)) throw new ReviewError('CONFLICT', 'Conflicting values in the same email');
          const withdrawals = changes.flatMap(c => c.supersedes);
          if (new Set(withdrawals).size !== withdrawals.length) throw new ReviewError('CONFLICT', 'A correction withdraws the same record more than once', true);
          if (group.issues.length) {
            const issue = group.issues.find(i => i.safety === 'possible') ?? group.issues[0]!;
            throw new ReviewError(issue.code, issue.detail, issue.safety === 'possible' && !['UNAUTHORIZED', 'INVALID_DOSE'].includes(issue.code), issue.scope);
          }
          validateResolutions(group.resolvesReviewIds, changes, store, identity);
          store.addChanges(changes, event.event_id, event.occurred_at);
          store.resolve(group.resolvesReviewIds, event.occurred_at);
        } catch (error) {
          const problem = error instanceof ReviewError ? error : new ReviewError('INVALID_VALUE', 'Invalid proposal');
          this.addReview(event, store, identity, problem.code, problem.message, problem.safety, problem.scope);
          // A rejected atomic group may still contain a credible closure or shortage. Preserve safety without accepting the group.
          for (const raw of group.changes) {
            let change: Change;
            try { change = validateChange(raw, event, store, identity); } catch { continue; }
            if (!isSafetyChange(change)) continue;
            const restrictive = (change.op === 'open.set' && !change.open) || (change.op === 'stock.set' && !change.available)
              || (change.op === 'state.set' && change.blocked) || change.op === 'capacity.set';
            if (restrictive) this.addReview(event, store, identity, 'CONFLICT', `${change.op}: Restrictive fact in a held atomic group`, true, changeScope(change), { from: change.effectiveFrom, until: change.effectiveUntil });
          }
        }
      }
    }
    await this.audit.reviews(store.reviews);
    const diagnostics = this.extractor.drainDiagnostics?.() ?? [];
    if (diagnostics.length) await this.audit.modelAttempts?.(diagnostics);
  }
  private async order(event: Extract<DeskEvent, { type: 'order' }>, store: Store, signal: AbortSignal): Promise<void> {
    const order = event.order;
    const hash = fingerprint({ ...order, medication: medicationName(order.medication), state: stateCode(order.state) ?? order.state, dose: doseName(order.dose) ?? order.dose });
    const old = store.submissions.get(order.order_id);
    if (old) {
      if (old.fingerprint !== hash) throw new DeskError(409, 'Order ID reused with different contents');
      if (old.status !== 'confirmed') throw new DeskError(502, 'Earlier submission is not confirmed; not resending');
      return;
    }
    signal.throwIfAborted();
    const day = dateET(event.occurred_at);
    const decision = route(order, event.occurred_at, store.snapshot(event.occurred_at), id => store.capacityUsed(id, day), store.config.catalogue);
    store.decisions.push(decision);
    const submission = { orderId: order.order_id, fingerprint: hash, target: decision.selected, dateET: day, status: 'pending' as 'pending' | 'confirmed' | 'rejected' | 'unknown', response: undefined as number | undefined };
    store.submissions.set(order.order_id, submission);
    try {
      const result = await abortable(this.pharmacy.submit(store.pharmacyApi, { order_id: order.order_id, pharmacy: decision.selected, reason: decision.reason }, signal), signal);
      submission.status = result.status;
      submission.response = result.response;
    } catch { submission.status = 'unknown'; }
    await this.audit.decision(decision, submission);
    if (submission.status !== 'confirmed') throw new DeskError(502, `Pharmacy submission ${submission.status}; not resending`);
  }
}
function duplicate(): Reply { return { status: 200, body: { status: 'duplicate' } }; }
function failure(status: number, error: string): Reply { return { status, body: { error } }; }
export function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Aborted'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    task.then(value => { if (!signal.aborted) resolve(value); }, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
