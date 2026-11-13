import { z } from 'zod';
import { changeSchema, extractionSchema, issueSchema, type Extraction } from './contracts.ts';

// Factor shared fields out of the seven operation branches. Repeating nullable
// time fields inside every branch makes the provider's compiled grammar explode.
export const commonChangeKeys = {
  pharmacyId: true, effectiveFrom: true, effectiveUntil: true,
  evidence: true, timeText: true, supersedes: true,
} as const;
const operationSchemas = changeSchema.options.map(variant => {
  const shape: z.ZodRawShape = Object.fromEntries(Object.entries(variant.shape).filter(([key]) => !Object.hasOwn(commonChangeKeys, key)));
  return z.object(shape).strict();
});
const operationSchema = z.union(operationSchemas);
const wireChangeSchema = changeSchema.options[0].pick(commonChangeKeys).extend({ action: operationSchema }).strict();
const wireSchema = z.object({ groups: z.array(z.object({
  changes: z.array(wireChangeSchema), issues: z.array(issueSchema), resolvesReviewIds: z.array(z.string()),
}).strict()) }).strict();

const unsupported = new Set(['$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems']);
function supportedSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(supportedSchema);
  if (!value || typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  if (Array.isArray(node.oneOf)) {
    const tags = node.oneOf.map(branch => branch?.properties?.op?.const);
    if (tags.some(tag => typeof tag !== 'string') || new Set(tags).size !== tags.length) throw new Error('Cannot safely convert a non-discriminated oneOf');
  }
  return Object.fromEntries(Object.entries(node).filter(([key]) => !unsupported.has(key)).map(([key, item]) => [key === 'oneOf' ? 'anyOf' : key, supportedSchema(item)]));
}
// Inline the compact schema to avoid $ref siblings without duplicating common fields.
export const anthropicOutputSchema = supportedSchema(z.toJSONSchema(wireSchema));

export function decodeAnthropicExtraction(input: unknown): Extraction {
  const wire = wireSchema.parse(input);
  return extractionSchema.parse({ groups: wire.groups.map(group => ({ ...group,
    changes: group.changes.map(change => {
      const { action, ...common } = change;
      return { ...common, ...action };
    }),
  })) });
}

export const anthropicTransportPrompt = `Transport format for this request: each change has outer fields pharmacyId, effectiveFrom, effectiveUntil, evidence, timeText, supersedes, and action. Put op and ALL operation-specific fields inside action, not at the outer level. The seven operations and their meanings above are unchanged. Example change: {"pharmacyId":"ID","effectiveFrom":"2026-11-09T08:00:00-05:00","effectiveUntil":null,"evidence":"We are closed","timeText":null,"supersedes":[],"action":{"op":"open.set","open":false}}. Historical changes in the input use the canonical flat format; only your output uses this nested transport format.`;
