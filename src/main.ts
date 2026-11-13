import { FileAudit } from './audit.ts';
import { Desk } from './desk.ts';
import { LlmExtractor } from './email.ts';
import { HttpPharmacyClient } from './pharmacy.ts';
import { createApp } from './server.ts';
import { configureProxy } from './proxy.ts';

const required = ['LLM_API_KEY', 'LLM_MODEL', 'LLM_BASE_URL'] as const;
for (const key of required) {
  if (!process.env[key]?.trim()) {
    console.error(`Missing ${key}. Copy .env.example to .env and configure the model.`);
    process.exit(1);
  }
}
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const providerValue = process.env.LLM_PROVIDER;
if (providerValue && providerValue !== 'anthropic' && providerValue !== 'openai') throw new Error('LLM_PROVIDER must be anthropic or openai');
const provider = providerValue === 'anthropic' ? 'anthropic' : providerValue === 'openai' ? 'openai' : undefined;
configureProxy();
const desk = new Desk({ extractor: new LlmExtractor({ apiKey: process.env.LLM_API_KEY!, model: process.env.LLM_MODEL!, baseUrl: process.env.LLM_BASE_URL!, provider, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID }), pharmacy: new HttpPharmacyClient(), audit: new FileAudit(process.env.AUDIT_DIR ?? 'out') });
const server = createApp(desk).listen(port, '127.0.0.1', () => console.log(`Pharmacy desk listening at http://localhost:${port}/webhooks`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, () => server.close());
