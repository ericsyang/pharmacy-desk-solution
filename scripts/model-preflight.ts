import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { configSchema, eventSchema, normalizeConfig } from '../src/contracts.ts';
import { LlmExtractor } from '../src/email.ts';
import { configureProxy } from '../src/proxy.ts';
import { Store } from '../src/store.ts';

// One real extraction validates the provider contract before any simulated order is sent.
export async function modelPreflight(diagnosticFile: string): Promise<void> {
  for (const key of ['LLM_API_KEY', 'LLM_MODEL', 'LLM_BASE_URL']) if (!process.env[key]?.trim()) throw new Error(`Missing ${key}`);
  const provider = process.env.LLM_PROVIDER;
  if (provider && provider !== 'anthropic' && provider !== 'openai') throw new Error('Invalid LLM_PROVIDER');
  const events = (await readFile(new URL('../sim/week-a.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const start = events.find(event => event.type === 'simulation.started');
  const event = eventSchema.parse(events.find(event => event.type === 'email'));
  if (event.type !== 'email') throw new Error('Week has no email for preflight');
  const store = new Store(normalizeConfig(configSchema.parse(start.config)), 'http://localhost:4000');
  configureProxy();
  // Allow initial provider schema compilation before the event stream starts;
  // actual webhook extraction retains its 20-second budget.
  const extractor = new LlmExtractor({ baseUrl: process.env.LLM_BASE_URL!, apiKey: process.env.LLM_API_KEY!, model: process.env.LLM_MODEL!, provider: provider === 'anthropic' ? 'anthropic' : provider === 'openai' ? 'openai' : undefined, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID, timeoutMs: 60_000 });
  try {
    await extractor.extract(event, store, new AbortController().signal);
    console.log('Model preflight passed: API and extraction contract accepted');
  } finally {
    const diagnostics = extractor.drainDiagnostics();
    await mkdir(dirname(diagnosticFile), { recursive: true });
    await writeFile(diagnosticFile, diagnostics.map(item => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 });
    for (const diagnostic of diagnostics.filter(item => item.outcome === 'failed')) {
      console.error(`Model attempt ${diagnostic.attempt}: ${diagnostic.code}; ${diagnostic.apiErrorMessage ?? diagnostic.networkCode ?? diagnostic.stopReason ?? 'see diagnostics'}`);
    }
  }
}
