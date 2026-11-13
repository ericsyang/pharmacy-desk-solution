import { modelPreflight } from './model-preflight.ts';
try {
  await modelPreflight('out/diagnostics/model-preflight.jsonl');
} catch {
  console.error('Model preflight failed. Details: out/diagnostics/model-preflight.jsonl');
  process.exitCode = 1;
}
