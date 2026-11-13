import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { test } from 'node:test';
import { Desk } from '../src/desk.ts';
import { createApp } from '../src/server.ts';
import { config, MemoryAudit } from './helpers.ts';

// Drive real HTTP request/response streams without opening a port; usable in restricted CI.
function dispatch(app: ReturnType<typeof createApp>, raw: string, headers: Record<string, string> = {}, path = '/webhooks', method = 'POST'): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    const req = new IncomingMessage(socket as Socket);
    req.method = method; req.url = path;
    req.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)), ...headers };
    const res = new ServerResponse(req);
    res.assignSocket(socket as Socket);
    res.on('error', reject);
    res.on('finish', () => {
      try {
        const http = Buffer.concat(chunks).toString();
        const body = http.slice(http.indexOf('\r\n\r\n') + 4);
        resolve({ status: res.statusCode, body: JSON.parse(body) });
      } catch (error) { reject(error); }
    });
    app(req, res);
    req.complete = true;
    req.push(raw); req.push(null);
  });
}
function app() {
  return createApp(new Desk({ extractor: { async extract() { return { groups: [] }; } }, pharmacy: { async submit() { return { status: 'confirmed', response: 201 }; } }, audit: new MemoryAudit() }));
}
test('HTTP endpoint parses JSON, initializes state and acknowledges duplicates', async () => {
  const server = app();
  const start = { type: 'simulation.started', event_id: 's', occurred_at: '2026-11-09T06:00:00-05:00', pharmacyApi: 'http://localhost:4000', config: config() };
  assert.deepEqual(await dispatch(server, JSON.stringify(start)), { status: 200, body: { status: 'processed' } });
  assert.deepEqual(await dispatch(server, JSON.stringify(start)), { status: 200, body: { status: 'duplicate' } });
});
test('HTTP endpoint rejects malformed JSON, schema errors and mismatched headers', async () => {
  const server = app();
  assert.equal((await dispatch(server, '{oops')).status, 400);
  assert.equal((await dispatch(server, '{}')).status, 400);
  const order = { type: 'order', event_id: 'o', occurred_at: '2026-11-09T06:00:00-05:00', order: { order_id: 'O', state: 'NY', medication: 'semaglutide', dose: '1mg' } };
  assert.equal((await dispatch(server, JSON.stringify(order), { 'x-event-id': 'different' })).status, 400);
});
test('HTTP health route reports initialization state', async () => {
  const reply = await dispatch(app(), '', {}, '/health', 'GET');
  assert.deepEqual(reply, { status: 200, body: { status: 'ok', initialized: false } });
});

test('HTTP rejects oversized payloads with 413', async () => {
  assert.equal((await dispatch(app(), JSON.stringify({ body: 'x'.repeat(300_000) }))).status, 413);
});
test('the complete public week passes through the HTTP layer with exact independent outcomes', async () => {
  const { readFile } = await import('node:fs/promises');
  const { week } = await import('./helpers.ts');
  const labels = JSON.parse(await readFile(new URL('fixtures/week-a-extractions.json', import.meta.url), 'utf8'));
  const expected = JSON.parse(await readFile(new URL('fixtures/week-a-expected.json', import.meta.url), 'utf8'));
  const targets: Record<string, string> = {};
  const desk = new Desk({ extractor: { async extract(event) { return structuredClone(labels[event.event_id]); } }, pharmacy: { async submit(_url, body) { assert.equal(targets[body.order_id], undefined); targets[body.order_id] = body.pharmacy; return { status: 'confirmed', response: 201 }; } }, audit: new MemoryAudit() });
  const server = createApp(desk);
  for (const original of await week()) {
    const event = original.type === 'simulation.started' ? { ...original, pharmacyApi: 'http://localhost:4000' } : original;
    const result = await dispatch(server, JSON.stringify(event), { 'x-event-id': event.event_id, 'x-sim-time': event.occurred_at });
    assert.equal(result.status, 200, event.event_id);
  }
  assert.deepEqual(targets, expected);
});
