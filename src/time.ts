import type { Change } from './contracts.ts';

const zone = 'America/New_York';
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function localParts(at: string | number): Record<string, string> {
  return Object.fromEntries(formatter.formatToParts(new Date(typeof at === 'string' ? Date.parse(at) : at)).map(p => [p.type, p.value]));
}
export function dateET(at: string): string {
  const p = localParts(at);
  return `${p.year}-${p.month}-${p.day}`;
}
export function shiftDate(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
export function midnightET(day: string): string {
  const desired = Date.parse(`${day}T00:00:00Z`);
  let instant = desired;
  for (let i = 0; i < 3; i++) {
    const p = localParts(instant);
    const shown = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    instant += desired - shown;
  }
  return new Date(instant).toISOString();
}
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export function weekdayDate(at: string, day: string, strictlyFuture = false): string {
  const today = dateET(at);
  const current = new Date(`${today}T12:00:00Z`).getUTCDay();
  let offset = (weekdays.indexOf(day.toLowerCase()) - current + 7) % 7;
  if (strictlyFuture && offset === 0) offset = 7;
  return shiftDate(today, offset);
}
export function active(from: string, until: string | null, at: string): boolean {
  const now = Date.parse(at);
  return Date.parse(from) <= now && (until === null || now < Date.parse(until));
}

// Only supported temporal phrases are checked here; uncertain language is reviewed, never guessed.
export function validateWindow(change: Change, receivedAt: string, body: string): void {
  const start = Date.parse(change.effectiveFrom);
  const end = change.effectiveUntil === null ? null : Date.parse(change.effectiveUntil);
  if (end !== null && end <= start) throw new Error('End must be after start');
  const raw = change.timeText;
  if (raw === null || raw.trim() === '') {
    if (start !== Date.parse(receivedAt) || end !== null) throw new Error('Undeclared time must start now without an invented end');
    return;
  }
  if (!body.includes(raw)) throw new Error('Time expression is not in the email');
  const phrase = raw.toLowerCase();
  const today = dateET(receivedAt);
  let expectedStart = Date.parse(receivedAt);
  let expectedEnd: number | null = null;
  let recognized = false;
  const days = weekdays.join('|');
  const startWeekday = new RegExp(`\\b(?:from|starting|effective|on)\\s+(?:next\\s+)?(${days})\\b`).exec(phrase);
  const endWeekday = new RegExp(`\\b(?:until|through|back(?:\\s+on)?|resumes?(?:\\s+on)?)\\s+(${days})\\b`).exec(phrase);
  const entireWeek = /rest of (?:the|this) week|remainder of (?:the|this) week/.test(phrase);
  const oneDayClosure = change.op === 'open.set' && !change.open && !/until|through|rest of|remainder of|indefinite|further notice/.test(phrase);
  if (/immediately|effective now|starting now/.test(phrase)) recognized = true;
  if (/\btomorrow\b/.test(phrase) && !/\buntil tomorrow\b/.test(phrase)) {
    expectedStart = Date.parse(midnightET(shiftDate(today, 1)));
    recognized = true;
  } else if (/\btoday\b/.test(phrase)) {
    recognized = true;
  }
  if (startWeekday?.[1] && !/\bback\s+on\b/.test(phrase)) {
    expectedStart = Date.parse(midnightET(weekdayDate(receivedAt, startWeekday[1])));
    recognized = true;
  }
  if (endWeekday?.[1]) {
    let date = weekdayDate(receivedAt, endWeekday[1], true);
    if (/\bthrough\b|\binclusive\b/.test(phrase)) date = shiftDate(date, 1);
    expectedEnd = Date.parse(midnightET(date));
    recognized = true;
  }
  if (/\buntil tomorrow\b/.test(phrase)) {
    expectedEnd = Date.parse(midnightET(shiftDate(today, 1)));
    recognized = true;
  }
  if (entireWeek) {
    expectedEnd = Date.parse(midnightET(weekdayDate(receivedAt, 'monday', true)));
    recognized = true;
  }
  const explicitDate = /\b(\d{4}-\d{2}-\d{2})\b/.exec(phrase);
  if (explicitDate?.[1]) {
    const instant = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/i.exec(raw)?.[0];
    if (/until|through/.test(phrase)) expectedEnd = Date.parse(instant ?? midnightET(explicitDate[1]));
    else expectedStart = Date.parse(instant ?? midnightET(explicitDate[1]));
    recognized = true;
  }
  if (oneDayClosure && recognized && expectedEnd === null && !/immediately|effective now|starting now/.test(phrase)) {
    expectedEnd = Date.parse(midnightET(shiftDate(dateET(new Date(expectedStart).toISOString()), 1)));
  }
  if (!recognized || /maybe|probably|tentative|around|sometime|next week|next (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)/.test(phrase)) throw new Error('Unsupported or ambiguous time expression');
  if (start !== expectedStart || end !== expectedEnd) throw new Error('Proposed dates disagree with the temporal policy');
}
