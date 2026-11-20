import express from 'express';
import { rm } from 'node:fs/promises';
import helmet from 'helmet';
import config from './config.js';
import { migrate } from './migrate.js';
import { pool } from './db.js';
import { HttpError } from './auth.js';
import publicRoutes from './routes/public.js';
import workerRoutes from './routes/worker.js';
import mcpRouter from './mcp.js';
import { startSweeper } from './sweeper.js';
import { rateLimit } from 'express-rate-limit';
import { receiveUploadByToken } from './jobs/service.js';

const STATUS_BY_CODE = {
  bundle_invalid: 400,
  bundle_too_large: 413,
  version_unsupported: 400,
  url_rejected: 400,
  storage_error: 502,
  insufficient_credits: 402,
  not_approved: 403,
  forbidden: 403,
  upload_invalid: 400,
  upload_in_progress: 409,
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

  // Upload links authenticate by their one-time token, so this sits before the API-key router.
  app.put(
    '/v1/uploads/:token',
    rateLimit({
      windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
      handler: (_req, _res, next) => next(new HttpError(429, 'rate_limited', 'Too many requests')),
    }),
    async (req, res, next) => {
      try {
        res.json(await receiveUploadByToken(req, req.params.token));
      } catch (err) {
        next(err);
      }
    },
  );
  app.use('/v1', publicRoutes);
  app.use('/mcp', mcpRouter);
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
