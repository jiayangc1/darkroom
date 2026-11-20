// Owner-only admin API (/api/admin), mounted behind the dashboard's Clerk auth.
import { Router } from 'express';
import { randomInt } from 'node:crypto';
import { pool, tx } from '../db.js';
import { HttpError } from '../auth.js';
import { approveAccount, addEntry, lockAccount } from '../billing/ledger.js';
import { disableAccount } from '../accounts.js';
import { usd } from '../billing/pricing.js';
import * as repo from '../jobs/repo.js';
import { UUID_RE } from '../jobs/service.js';

const router = Router();
router.use((req, _res, next) => next(req.isAdmin ? undefined : new HttpError(403, 'forbidden', 'Admins only')));

const h = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};
const accountId = (req) => {
  if (!UUID_RE.test(req.params.id)) throw new HttpError(404, 'not_found', 'Account not found');
  return req.params.id;
};
const acctPublic = (a) => ({
  id: a.id, name: a.name, email: a.email, plan: a.plan, balance: usd(a.balance_micro),
  createdAt: a.created_at, approvedAt: a.approved_at, disabledAt: a.disabled_at, jobs: a.jobs === undefined ? undefined : Number(a.jobs),
});

router.get('/waitlist', h(async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM accounts WHERE plan = 'waitlist' AND disabled_at IS NULL ORDER BY created_at`);
  res.json({ accounts: rows.map(acctPublic) });
}));

router.post('/accounts/:id/approve', h(async (req, res) => {
  const id = accountId(req);
  res.json({ account: acctPublic(await tx((c) => approveAccount(c, id, { by: req.userId }))) });
}));

router.get('/accounts', h(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT a.*, (SELECT count(*) FROM jobs j WHERE j.account_id = a.id) AS jobs
       FROM accounts a ORDER BY a.created_at DESC LIMIT 500`,
  );
  res.json({ accounts: rows.map(acctPublic) });
}));

router.post('/accounts/:id/disable', h(async (req, res) => {
  const id = accountId(req);
  await tx(async (c) => {
    await lockAccount(c, id);
    await disableAccount(c, id);
  });
  res.json({ ok: true });
}));

/** Manual money movement: a grant (±) or a refund recorded after refunding in Stripe (stored negative). */
router.post('/accounts/:id/ledger', h(async (req, res) => {
  const id = accountId(req);
  const kind = req.body?.kind;
  const amount = Number(req.body?.amountUsd);
  if (!['grant', 'refund'].includes(kind)) throw new HttpError(400, 'bad_request', 'kind must be grant or refund');
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 10_000) throw new HttpError(400, 'bad_request', 'amountUsd must be a non-zero number');
  const micro = Math.round((kind === 'refund' ? -Math.abs(amount) : amount) * 1e6);
  const note = String(req.body?.note || '').slice(0, 300) || null;
  await tx(async (c) => {
    await lockAccount(c, id);
    await addEntry(c, { accountId: id, kind, amountMicro: micro, note, createdBy: req.userId });
  });
  res.json({ account: acctPublic(await repo.accountRow(id)) });
}));

// ---- invite codes ----
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const chunk = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

router.get('/invites', h(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM invite_codes ORDER BY created_at DESC LIMIT 500');
  res.json({
    invites: rows.map((r) => ({
      code: r.code, note: r.note, maxUses: r.max_uses, uses: r.uses, expiresAt: r.expires_at, createdAt: r.created_at, disabledAt: r.disabled_at,
    })),
  });
}));

router.post('/invites', h(async (req, res) => {
  const maxUses = Number(req.body?.maxUses ?? 1);
  const days = req.body?.expiresInDays === undefined || req.body?.expiresInDays === null || req.body?.expiresInDays === '' ? null : Number(req.body.expiresInDays);
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) throw new HttpError(400, 'bad_request', 'maxUses must be 1–1000');
  if (days !== null && (!Number.isFinite(days) || days <= 0 || days > 365)) throw new HttpError(400, 'bad_request', 'expiresInDays must be 1–365');
  const code = `DRK-${chunk()}-${chunk()}`;
  const { rows } = await pool.query(
    `INSERT INTO invite_codes (code, note, max_uses, expires_at)
     VALUES ($1, $2, $3, CASE WHEN $4::numeric IS NULL THEN NULL ELSE now() + $4::numeric * interval '1 day' END) RETURNING *`,
    [code, String(req.body?.note || '').slice(0, 200) || null, maxUses, days],
  );
  res.status(201).json({ code: rows[0].code, maxUses: rows[0].max_uses, expiresAt: rows[0].expires_at });
}));

router.post('/invites/:code/disable', h(async (req, res) => {
  const { rowCount } = await pool.query('UPDATE invite_codes SET disabled_at = coalesce(disabled_at, now()) WHERE code = $1', [req.params.code]);
  if (!rowCount) throw new HttpError(404, 'not_found', 'Invite not found');
  res.json({ ok: true });
}));

router.get('/jobs', h(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT j.*, a.email AS account_email, a.name AS account_name FROM jobs j JOIN accounts a ON a.id = j.account_id
      ORDER BY j.created_at DESC LIMIT 100`,
  );
  res.json({ jobs: rows.map((r) => ({ ...repo.toPublic(r), account: r.account_email || r.account_name })) });
}));

export default router;
