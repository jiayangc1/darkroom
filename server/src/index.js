import express from 'express';
import { rm } from 'node:fs/promises';
import helmet from 'helmet';
import config from './config.js';
import { migrate } from './migrate.js';
import { pool } from './db.js';
import { HttpError } from './auth.js';
import publicRoutes from './routes/public.js';
import workerRoutes from './routes/worker.js';
import { startSweeper } from './sweeper.js';

const STATUS_BY_CODE = {
  bundle_invalid: 400,
  bundle_too_large: 413,
  version_unsupported: 400,
  url_rejected: 400,
  storage_error: 502,
};

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet());

  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use('/v1', publicRoutes);
  app.use('/worker', workerRoutes);

  app.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'Not found')));

  app.use((err, req, res, _next) => {
    const status = err.status || STATUS_BY_CODE[err.code] || (err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error('[error]', err);
    const code = status === 500 && !STATUS_BY_CODE[err.code] ? 'internal' : err.code || 'error';
    const message = status === 500 && code === 'internal' ? 'Internal error' : err.message;
    if (res.headersSent) return;
    if (req.darkroomCloseAfterResponse) {
      // Don't keep reading a body we've already rejected (oversized / stalled upload).
      res.setHeader('Connection', 'close');
      res.on('finish', () => req.destroy());
    }
    res.status(status).json({ error: { code, message } });
  });
  return app;
}

async function main() {
  await migrate();
  // Spool files left by a previous process (crash mid-upload) are never needed again.
  await rm(config.uploadDir, { recursive: true, force: true }).catch(() => {});
  const app = createApp();
  const server = app.listen(config.port, () => console.log(`[darkroom] listening on :${config.port}`));
  const stopSweeper = startSweeper();
  server.requestTimeout = 0; // large uploads; per-route limits apply instead
  server.headersTimeout = 60_000;
  const shutdown = () => {
    console.log('[darkroom] shutting down');
    stopSweeper();
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 30_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
