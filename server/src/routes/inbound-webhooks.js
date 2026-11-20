// Webhooks Darkroom receives (Clerk, Stripe). Mounted with express.raw so signatures verify on the exact bytes.
import { verifyWebhook } from '@clerk/express/webhooks';
import config from '../config.js';
import { pool, tx } from '../db.js';
import { disableAccount } from '../accounts.js';
import { constructEvent, handleStripeEvent } from '../billing/stripe.js';

export async function clerkWebhook(req, res) {
  let evt;
  try {
    evt = await verifyWebhook(req, { signingSecret: config.clerk.webhookSecret });
  } catch {
    return res.status(400).json({ error: { code: 'bad_signature', message: 'Webhook verification failed' } });
  }
  try {
    if (evt.type === 'user.deleted' && evt.data?.id) {
      const { rows } = await pool.query('SELECT id FROM accounts WHERE clerk_user_id = $1', [evt.data.id]);
      if (rows[0]) await tx((c) => disableAccount(c, rows[0].id));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[clerk webhook]', err);
    res.status(500).json({ error: { code: 'internal', message: 'Internal error' } });
  }
}

export async function stripeWebhook(req, res) {
  let event;
  try {
    event = constructEvent(req.body, req.get('stripe-signature'));
  } catch (err) {
    return res.status(err.status === 503 ? 503 : 400).json({ error: { code: 'bad_signature', message: err.message } });
  }
  try {
    await handleStripeEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe webhook]', err); // 500 makes Stripe retry
    res.status(500).json({ error: { code: 'internal', message: 'Internal error' } });
  }
}
