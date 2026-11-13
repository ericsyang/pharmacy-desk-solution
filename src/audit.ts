import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Decision, Review, Submission } from './contracts.ts';
import type { ModelDiagnostic } from './email.ts';

export interface Audit {
  reset(): Promise<void>;
  reviews(items: Review[]): Promise<void>;
  decision(decision: Decision, submission: Submission): Promise<void>;
  modelAttempts?(attempts: ModelDiagnostic[]): Promise<void>;
}
export class FileAudit implements Audit {
  private directory: string;
  constructor(directory = 'out') { this.directory = directory; }
  async reset(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, 'decisions.jsonl'), '', { mode: 0o600 });
    await writeFile(join(this.directory, 'model-attempts.jsonl'), '', { mode: 0o600 });
    await this.reviews([]);
  }
  async reviews(items: Review[]): Promise<void> {
    const file = join(this.directory, 'reviews.json');
    await writeFile(`${file}.tmp`, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  async decision(decision: Decision, submission: Submission): Promise<void> {
    await appendFile(join(this.directory, 'decisions.jsonl'), `${JSON.stringify({ ...decision, submission })}\n`, { mode: 0o600 });
  }
  async modelAttempts(attempts: ModelDiagnostic[]): Promise<void> {
    if (attempts.length) await appendFile(join(this.directory, 'model-attempts.jsonl'), attempts.map(attempt => JSON.stringify(attempt)).join('\n') + '\n', { mode: 0o600 });
  }
}
