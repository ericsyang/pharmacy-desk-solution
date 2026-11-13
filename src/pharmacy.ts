export type SubmitResult = { status: 'confirmed' | 'rejected' | 'unknown'; response?: number };
export interface PharmacyClient { submit(baseUrl: string, body: { order_id: string; pharmacy: string; reason: string }, signal: AbortSignal): Promise<SubmitResult> }
export class HttpPharmacyClient implements PharmacyClient {
  private fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = fetch) { this.fetcher = fetcher; }
  async submit(baseUrl: string, body: { order_id: string; pharmacy: string; reason: string }, signal: AbortSignal): Promise<SubmitResult> {
    try {
      const response = await this.fetcher(`${baseUrl.replace(/\/$/, '')}/pharmacy-orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
      });
      await response.body?.cancel();
      return { status: response.status === 201 ? 'confirmed' : [400, 404].includes(response.status) ? 'rejected' : 'unknown', response: response.status };
    } catch { return { status: 'unknown' }; }
  }
}
