// Dashboard API (/api): Clerk session auth, for the web app only. Agents use /v1 and /mcp.
import express, { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { clerkMiddleware, getAuth } from '@clerk/express';
import { rateLimit } from 'express-rate-limit';
import config, { accountLimits } from '../config.js';
import { pool, tx } from '../db.js';
import { HttpError, newToken, hashToken } from '../auth.js';
import { accountForClerkUser, newWebhookSecret } from '../accounts.js';
import { availableMicro, approveAccount, listLedger, lockAccount } from '../billing/ledger.js';
import { priceSheet, usd } from '../billing/pricing.js';
import * as repo from '../jobs/repo.js';
import { getJobFor, listJobsFor, cancelJob, UUID_RE } from '../jobs/service.js';
import { workerStatus, queuedCount, withLiveStatus } from '../status.js';
import { createCheckout } from '../billing/stripe.js';
import adminRoutes from './admin-api.js';

const MAX_KEYS = 10;

/** Public, unauthenticated settings the SPA needs before it can start Clerk. */
export function publicConfig(_req, res) {
  res.json({
    clerkPublishableKey: config.clerk.publishableKey,
    signupMode: config.signupMode,
    prices: priceSheet(),
    allowlist: config.egressAllowlist,
    retentionDays: config.retentionDays,
  });
}

async function requireUser(req, _res, next) {
  try {
    const { userId } = getAuth(req);
    if (!userId) throw new HttpError(401, 'unauthorized', 'Sign in first');
    const acct = await accountForClerkUser(userId);
    if (acct.disabled_at) throw new HttpError(403, 'forbidden', 'This account is disabled');
    req.userId = userId;
    req.account = { id: acct.id, plan: acct.plan, limits: acct.limits, email: acct.email, row: acct };
    req.isAdmin = config.adminClerkUserIds.includes(userId);
    next();
  } catch (err) {
    next(err);
  }
}

const requireApproved = (req, _res, next) =>
  next(req.account.plan === 'waitlist' ? new HttpError(403, 'not_approved', 'Your account is on the waitlist') : undefined);

const ledgerPublic = (r) => ({
  id: Number(r.id), at: r.at, kind: r.kind, amount: usd(r.amount_micro), jobId: r.job_id, note: r.note,
});

const router = Router();
router.use(clerkMiddleware(), express.json({ limit: '64kb' }), requireUser);
router.use(
  rateLimit({
    windowMs: 60_000, limit: 120, keyGenerator: (req) => req.userId, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'rate_limited', 'Too many requests')),
  }),
);

const h = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

router.get('/me', h(async (req, res) => {
  const a = await repo.accountRow(req.account.id);
  const lim = accountLimits(a);
  res.json({
    account: {
      id: a.id, name: a.name, email: a.email, plan: a.plan,
      balance: usd(a.balance_micro), available: usd(await availableMicro(pool, a.id)), approvedAt: a.approved_at,
    },
    limits: { maxDurationSec: lim.maxDurationSec, maxPixels: lim.maxPixels, maxFps: lim.maxFps, maxActiveJobs: lim.maxActiveJobs },
    isAdmin: req.isAdmin,
  });
}));

// ---- jobs ----
router.get('/jobs', h(async (req, res) => {
  const rows = await listJobsFor(req.account.id, { limit: req.query.limit || 25, before: req.query.before });
  const jobs = rows.map(repo.toPublic);
  res.json({ jobs, next: jobs.length ? jobs[jobs.length - 1].createdAt : null });
}));
router.get('/jobs/:id', h(async (req, res) => {
  const job = await getJobFor(req.account.id, req.params.id);
  res.json(await withLiveStatus(repo.toPublic(job), job));
}));
router.delete('/jobs/:id', h(async (req, res) => {
  res.json(repo.toPublic(await cancelJob(req.account.id, req.params.id)));
}));

// ---- API keys ----
router.get('/keys', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, prefix, label, created_at, last_used_at, revoked_at FROM api_keys
      WHERE account_id = $1 ORDER BY revoked_at IS NOT NULL, created_at DESC`,
    [req.account.id],
  );
  res.json({ keys: rows.map((k) => ({ id: k.id, prefix: k.prefix, label: k.label, createdAt: k.created_at, lastUsedAt: k.last_used_at, revokedAt: k.revoked_at })) });
}));
router.post('/keys', requireApproved, h(async (req, res) => {
  const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 100) : '';
  const key = newToken('dr_live_');
  const id = randomUUID();
  await tx(async (c) => {
    await lockAccount(c, req.account.id);
    const { rows } = await c.query('SELECT count(*)::int AS n FROM api_keys WHERE account_id = $1 AND revoked_at IS NULL', [req.account.id]);
    if (rows[0].n >= MAX_KEYS) throw new HttpError(409, 'too_many_keys', `At most ${MAX_KEYS} active keys; revoke one first`);
    await c.query('INSERT INTO api_keys (id, account_id, prefix, hash, label) VALUES ($1, $2, $3, $4, $5)', [
      id, req.account.id, key.slice(0, 12), hashToken(key), label || null,
    ]);
  });
  res.status(201).json({ id, key, prefix: key.slice(0, 12), label: label || null });
}));
router.delete('/keys/:id', h(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) throw new HttpError(404, 'not_found', 'Key not found');
  const { rowCount } = await pool.query(
    'UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 AND account_id = $2',
    [req.params.id, req.account.id],
  );
  if (!rowCount) throw new HttpError(404, 'not_found', 'Key not found');
  res.json({ ok: true });
}));

// ---- webhook secret ----
router.get('/webhook-secret', h(async (req, res) => {
  res.json({ secret: (await repo.accountRow(req.account.id)).webhook_secret });
}));
router.post('/webhook-secret/rotate', h(async (req, res) => {
  const secret = newWebhookSecret();
  await pool.query('UPDATE accounts SET webhook_secret = $2 WHERE id = $1', [req.account.id, secret]);
  res.json({ secret });
}));

// ---- invite codes ----
router.post('/invite/redeem', h(async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) throw new HttpError(400, 'invite_invalid', 'Enter an invite code');
  await tx(async (c) => {
    const acct = await lockAccount(c, req.account.id);
    if (acct.plan !== 'waitlist') throw new HttpError(409, 'already_approved', 'Your account is already active');
    const { rows } = await c.query('SELECT * FROM invite_codes WHERE code = $1 FOR UPDATE', [code]);
    const inv = rows[0];
    if (!inv || inv.disabled_at || (inv.expires_at && new Date(inv.expires_at) < new Date()) || inv.uses >= inv.max_uses) {
      throw new HttpError(400, 'invite_invalid', 'That invite code is not valid');
    }
    await approveAccount(c, acct.id, { by: `invite:${code}` });
    await c.query('UPDATE invite_codes SET uses = uses + 1 WHERE code = $1', [code]);
  });
  res.json({ ok: true });
}));

// ---- billing ----
router.get('/billing', h(async (req, res) => {
  const a = await repo.accountRow(req.account.id);
  res.json({
    balance: usd(a.balance_micro),
    available: usd(await availableMicro(pool, a.id)),
    plan: a.plan,
    ledger: (await listLedger(a.id)).map(ledgerPublic),
  });
}));
router.post('/billing/checkout', requireApproved, h(async (req, res) => {
  res.json({ url: await createCheckout(await repo.accountRow(req.account.id), Number(req.body?.pack)) });
}));

// ---- status ----
router.get('/status', h(async (_req, res) => {
  res.json({ ...(await workerStatus()), queued: await queuedCount() });
}));

router.use('/admin', adminRoutes);

export default router;
export { ledgerPublic };
