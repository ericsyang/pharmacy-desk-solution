import { readFile } from 'node:fs/promises';
import type { Audit } from '../src/audit.ts';
import type { Change, Config, Decision, DeskEvent, EmailEvent, Review, Submission } from '../src/contracts.ts';

export function config(): Config {
  return { catalogue: { semaglutide: ['0.5mg', '1mg'], tirzepatide: ['2.5mg', '5mg', '7.5mg'] }, lumimedsOps: ['sam@lumimeds.example'], pharmacies: [
    { id: 'A', name: 'A Pharmacy', contacts: ['a@pharmacy.example'], open: true, shipsInDays: 1, dailyCapacity: 2, price: { semaglutide: 140, tirzepatide: 210 }, blockedStates: ['TX'], stock: { semaglutide: ['0.5mg', '1mg'], tirzepatide: ['2.5mg', '5mg', '7.5mg'] } },
    { id: 'B', name: 'B Pharmacy', contacts: ['b@pharmacy.example'], open: true, shipsInDays: 2, dailyCapacity: 3, price: { semaglutide: 100, tirzepatide: 180 }, blockedStates: ['CA'], stock: { semaglutide: ['0.5mg', '1mg'], tirzepatide: ['2.5mg', '5mg', '7.5mg'] } },
    { id: 'C', name: 'C Pharmacy', contacts: ['c@pharmacy.example'], open: true, shipsInDays: 1, dailyCapacity: 2, price: { semaglutide: 150, tirzepatide: 220 }, blockedStates: [], stock: { semaglutide: ['0.5mg', '1mg'], tirzepatide: ['2.5mg', '5mg'] } },
  ] };
}
export const monday = '2026-11-09T08:00:00-05:00';
export function change(overrides: Record<string, unknown> = {}): Change {
  return { pharmacyId: 'A', effectiveFrom: monday, effectiveUntil: null, evidence: 'We are closed', timeText: null, supersedes: [], ...(overrides.op && overrides.op !== 'open.set' ? {} : { op: 'open.set', open: false }), ...overrides } as Change;
}
export function email(body = 'We are closed', from = 'a@pharmacy.example', at = monday, id = 'email-1'): EmailEvent {
  return { type: 'email', event_id: id, occurred_at: at, email: { from, subject: 'Update', body } };
}
export class MemoryAudit implements Audit {
  items: Review[] = [];
  decisions: { decision: Decision; submission: Submission }[] = [];
  async reset() { this.items = []; this.decisions = []; }
  async reviews(items: Review[]) { this.items = structuredClone(items); }
  async decision(decision: Decision, submission: Submission) { this.decisions.push(structuredClone({ decision, submission })); }
}
export async function week(): Promise<DeskEvent[]> {
  return (await readFile(new URL('../sim/week-a.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
