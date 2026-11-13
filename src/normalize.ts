const stateNames = `AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|WV:West Virginia|WI:Wisconsin|WY:Wyoming|DC:District of Columbia`;
const states = new Map<string, string>();
for (const item of stateNames.split('|')) {
  const [code, name] = item.split(':') as [string, string];
  states.set(code.toLowerCase(), code);
  states.set(name.toLowerCase(), code);
}
export const emailAddress = (value: string): string => value.trim().toLowerCase();
export const stateCode = (value: string): string | undefined => states.get(value.trim().toLowerCase());
export const medicationName = (value: string): string => value.trim().toLowerCase();
export function doseName(value: string): string | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*mg$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0 ? `${amount}mg` : undefined;
}
export function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${fingerprint(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
