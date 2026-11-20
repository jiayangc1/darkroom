import express from 'express';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import helmet from 'helmet';
import config from './config.js';
import { migrate } from './migrate.js';
import { pool } from './db.js';
import { HttpError } from './auth.js';
import publicRoutes from './routes/public.js';
import workerRoutes from './routes/worker.js';
import mcpRouter from './mcp.js';
import dashboardRoutes, { publicConfig } from './routes/dashboard.js';
import { clerkWebhook, stripeWebhook } from './routes/inbound-webhooks.js';
import { startSweeper } from './sweeper.js';
import { rateLimit } from 'express-rate-limit';
import { receiveUploadByToken } from './jobs/service.js';

const STATUS_BY_CODE = {
  bundle_invalid: 400,
  bundle_too_large: 413,
  version_unsupported: 400,
  url_rejected: 400,
  billing_unavailable: 503,
  storage_error: 502,
  insufficient_credits: 402,
  not_approved: 403,
  forbidden: 403,
  upload_invalid: 400,
  upload_in_progress: 409,
};

/** The Clerk Frontend API host is encoded in the publishable key (pk_<env>_<base64 host$>). */
function clerkFrontendApi() {
  const part = config.clerk.publishableKey.split('_')[2];
  if (!part) return null;
  return Buffer.from(part, 'base64').toString('utf8').replace(/\$$/, '');
}

function cspDirectives() {
  const fapi = clerkFrontendApi();
  // Clerk: its Frontend API, plus Clerk Protect (bot protection on sign-up).
  const clerk = [...(fapi ? [`https://${fapi}`] : []), 'https://*.protect.clerk.com'];
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", ...clerk, 'https://challenges.cloudflare.com'],
    // Clerk Protect probes from per-instance hosts on several ports.
    connectSrc: ["'self'", ...clerk, 'https://*.client.protect.clerk.com:*', 'https://clerk-telemetry.com'],
    imgSrc: ["'self'", 'data:', 'https://img.clerk.com'],
    frameSrc: ["'self'", 'https://challenges.cloudflare.com'],
    workerSrc: ["'self'", 'blob:'],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    mediaSrc: ["'self'", ...(config.bunny.cdnBase ? [config.bunny.cdnBase] : [])],
    formAction: ["'self'", 'https://checkout.stripe.com'],
  };
}

const API_PREFIX = /^\/(v1|api|mcp|worker|webhooks|healthz)(\/|$)/;

/** Serve the built SPA (web/dist) with an index.html fallback for client-side routes. */
function serveWebApp(app) {
  const index = path.join(config.webDist, 'index.html');
  if (!existsSync(index)) {
    console.log(`[web] no build at ${config.webDist}; dashboard not served`);
    return;
  }
  app.use(
    express.static(config.webDist, {
      index: false,
      setHeaders: (res, file) => {
        if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );
  // Clerk production is bound to the canonical domain, so dashboard pages on an alias host
  // (e.g. darkroom.lsjc.dev) redirect there. API, MCP and worker routes still answer on every host.
  const canonicalHost = new URL(config.publicBaseUrl).host;
  app.get('*', (req, res, next) => {
    if (API_PREFIX.test(req.path)) return next();
    if (req.get('host') && req.get('host') !== canonicalHost) return res.redirect(301, `${config.publicBaseUrl}${req.originalUrl}`);
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
}

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: cspDirectives() } }));

  // Inbound webhooks need the raw body for signature checks, so they come before any JSON parser.
  app.post('/webhooks/clerk', express.raw({ type: 'application/json', limit: '1mb' }), clerkWebhook);
  app.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhook);

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
  app.get('/api/public-config', publicConfig);
  app.use('/api', dashboardRoutes);

  serveWebApp(app);

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
