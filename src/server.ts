import express, { type ErrorRequestHandler } from 'express';
import { Desk } from './desk.ts';

export function createApp(desk: Desk) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb', strict: true }));
  app.get('/health', (_req, res) => { res.json({ status: 'ok', initialized: Boolean(desk.store) }); });
  app.post('/webhooks', async (req, res) => {
    const reply = await desk.handle(req.body, { eventId: req.get('x-event-id'), simTime: req.get('x-sim-time') });
    res.status(reply.status).json(reply.body);
  });
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const status = error && typeof error === 'object' && 'status' in error && error.status === 413 ? 413 : error instanceof SyntaxError ? 400 : 500;
    res.status(status).json({ error: status === 413 ? 'Payload too large' : status === 400 ? 'Invalid JSON' : 'Internal error' });
  };
  app.use(errorHandler);
  return app;
}
