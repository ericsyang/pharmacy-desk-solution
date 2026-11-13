import { z } from 'zod';
import { doseName, emailAddress, medicationName, stateCode } from './normalize.ts';

const text = z.string().trim().min(1).max(20_000);
export const isoTime = z.iso.datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)), 'Invalid ISO timestamp');
const nonnegative = z.number().finite().nonnegative();
const pharmacySchema = z.object({
  id: text, name: text, contacts: z.array(z.string().trim().pipe(z.email())).min(1),
  open: z.boolean(), shipsInDays: nonnegative, dailyCapacity: nonnegative.int(),
  price: z.record(z.string(), nonnegative), blockedStates: z.array(text),
  stock: z.record(z.string(), z.array(text)),
}).strict();
export const configSchema = z.object({
  catalogue: z.record(z.string(), z.array(text).min(1)),
  lumimedsOps: z.array(z.string().trim().pipe(z.email())), pharmacies: z.array(pharmacySchema).min(1),
}).strict();
export type Config = z.infer<typeof configSchema>;
export type Pharmacy = Config['pharmacies'][number];
export const orderSchema = z.object({ order_id: text, state: text, medication: text, dose: text }).strict();
export type Order = z.infer<typeof orderSchema>;
const envelope = { event_id: text, occurred_at: isoTime };
export const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('simulation.started'), pharmacyApi: z.url(), config: configSchema }).strict(),
  z.object({ ...envelope, type: z.literal('email'), email: z.object({ from: text, subject: z.string().max(2000), body: z.string().max(50_000) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('order'), order: orderSchema }).strict(),
]);
export type DeskEvent = z.infer<typeof eventSchema>;
export type EmailEvent = Extract<DeskEvent, { type: 'email' }>;
export type StartEvent = Extract<DeskEvent, { type: 'simulation.started' }>;
export type Scope = { pharmacyId?: string; medication?: string; dose?: string; state?: string };
const scopeSchema = z.object({ pharmacyId: text.optional(), medication: text.optional(), dose: text.optional(), state: text.optional() }).strict();
export const issueSchema = z.object({
  code: z.enum(['UNAUTHORIZED', 'INVALID_DOSE', 'INVALID_VALUE', 'AMBIGUOUS_TIME', 'CONFLICT', 'UNSUPPORTED']),
  detail: text, safety: z.enum(['possible', 'none']), scope: scopeSchema.optional(),
}).strict();
export type Issue = z.infer<typeof issueSchema>;
const common = {
  pharmacyId: text, effectiveFrom: isoTime, effectiveUntil: isoTime.nullable(),
  evidence: text, timeText: z.string().nullable(), supersedes: z.array(text).default([]),
};
export const changeSchema = z.discriminatedUnion('op', [
  z.object({ ...common, op: z.literal('stock.set'), medication: text, dose: text, available: z.boolean() }).strict(),
  z.object({ ...common, op: z.literal('state.set'), state: text, blocked: z.boolean() }).strict(),
  z.object({ ...common, op: z.literal('open.set'), open: z.boolean() }).strict(),
  z.object({ ...common, op: z.literal('capacity.set'), dailyCapacity: nonnegative.int() }).strict(),
  z.object({ ...common, op: z.literal('shipping.set'), shipsInDays: nonnegative }).strict(),
  z.object({ ...common, op: z.literal('price.set'), medication: text, usd: nonnegative }).strict(),
  z.object({ ...common, op: z.literal('routing.prefer'), match: z.object({ medication: text.optional(), dose: text.optional(), state: text.optional() }).strict() }).strict(),
]);
export type Change = z.infer<typeof changeSchema>;
// Each group is validated independently, so one malformed proposal cannot erase an unrelated closure.
export const extractionSchema = z.object({ groups: z.array(z.object({
  changes: z.array(z.unknown()).max(50), issues: z.array(issueSchema).max(20),
  resolvesReviewIds: z.array(text).max(20),
}).strict()).max(50) }).strict();
export type Extraction = z.infer<typeof extractionSchema>;
export type ChangeRecord = { changeId: string; sourceEventId: string; receivedAt: string; sequence: number; change: Change; withdrawnAt?: string; withdrawnSequence?: number };
export type Hold = { scope: Scope; from: string; until: string | null; resolvedAt?: string; resolvedSequence?: number };
export type Review = { reviewId: string; eventId: string; receivedAt: string; sequence: number; sender: string; email: EmailEvent['email']; reasonCode: string; detail: string; status: 'pending' | 'resolved'; hold?: Hold };
export type Submission = { orderId: string; fingerprint: string; target: string; dateET: string; status: 'pending' | 'confirmed' | 'rejected' | 'unknown'; response?: number };
export type Decision = { orderId: string; eventTime: string; candidates: string[]; exclusions: Record<string, string[]>; appliedChangeIds: string[]; selected: string; reason: string };
export type Identity = { kind: 'ops' } | { kind: 'pharmacy'; pharmacyId: string } | { kind: 'unknown' };

export function normalizeConfig(input: Config): Config {
  const config = structuredClone(input);
  const ids = new Set<string>();
  const addresses = new Set<string>();
  const catalogue: Config['catalogue'] = {};
  for (const [drug, values] of Object.entries(config.catalogue)) {
    const key = medicationName(drug);
    if (catalogue[key]) throw new Error('Duplicate catalogue medication');
    catalogue[key] = values.map(value => {
      const dose = doseName(value);
      if (!dose) throw new Error('Invalid catalogue dose');
      return dose;
    });
    if (new Set(catalogue[key]).size !== values.length) throw new Error('Duplicate catalogue dose');
  }
  if (!Object.keys(catalogue).length) throw new Error('Empty catalogue');
  config.catalogue = catalogue;
  config.lumimedsOps = config.lumimedsOps.map(emailAddress);
  for (const address of config.lumimedsOps) {
    if (addresses.has(address)) throw new Error('Duplicate contact');
    addresses.add(address);
  }
  for (const pharmacy of config.pharmacies) {
    if (ids.has(pharmacy.id) || pharmacy.id === 'MANUAL') throw new Error('Invalid or duplicate pharmacy ID');
    ids.add(pharmacy.id);
    pharmacy.contacts = pharmacy.contacts.map(emailAddress);
    for (const address of pharmacy.contacts) {
      if (addresses.has(address)) throw new Error('Ambiguous contact ownership');
      addresses.add(address);
    }
    pharmacy.blockedStates = pharmacy.blockedStates.map(value => {
      const code = stateCode(value);
      if (!code) throw new Error('Invalid blocked state');
      return code;
    });
    const stock: Pharmacy['stock'] = {};
    for (const [drug, values] of Object.entries(pharmacy.stock)) {
      const key = medicationName(drug);
      if (!catalogue[key] || stock[key]) throw new Error('Invalid stock medication');
      stock[key] = values.map(value => {
        const dose = doseName(value);
        if (!dose || !catalogue[key]?.includes(dose)) throw new Error('Stock outside catalogue');
        return dose;
      });
    }
    pharmacy.stock = stock;
    pharmacy.price = Object.fromEntries(Object.entries(pharmacy.price).map(([drug, price]) => [medicationName(drug), price]));
    for (const drug of Object.keys(stock)) if (pharmacy.price[drug] === undefined) throw new Error('Missing medication price');
  }
  return config;
}
