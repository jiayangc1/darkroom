// Stripe Checkout for prepaid credit packs. Credits land via the signed webhook, never the redirect.
import Stripe from 'stripe';
import config from '../config.js';
import { pool, tx } from '../db.js';
import { HttpError } from '../auth.js';
import { addEntry, lockAccount } from './ledger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let client = null;
const stripe = () => {
  if (!config.stripe.secretKey) throw new HttpError(503, 'billing_unavailable', 'Billing is not configured');
  client ??= new Stripe(config.stripe.secretKey);
  return client;
};

/** Start a Checkout Session for a pack; returns the hosted page URL. Tax is added on top (tax-exclusive). */
export async function createCheckout(account, pack) {
  if (account.plan === 'waitlist') throw new HttpError(403, 'not_approved', 'Your account is on the waitlist');
  if (!config.packs.includes(pack)) throw new HttpError(400, 'bad_request', `pack must be one of ${config.packs.join(', ')}`);
  let customer = account.stripe_customer_id;
  if (!customer) {
    const c = await stripe().customers.create({
      email: account.email || undefined, name: account.name || undefined, metadata: { accountId: account.id },
    });
    customer = c.id;
    await pool.query('UPDATE accounts SET stripe_customer_id = coalesce(stripe_customer_id, $2) WHERE id = $1', [account.id, customer]);
  }
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    customer,
    customer_update: { address: 'auto', name: 'auto' },
    automatic_tax: { enabled: true },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: pack * 100,
        tax_behavior: 'exclusive',
        product_data: { name: `Darkroom credits — $${pack}`, description: 'Prepaid render credit' },
      },
    }],
    // The Stripe account is shared with other products; `app` marks Darkroom's own sessions.
    metadata: { app: 'darkroom', accountId: account.id, pack: String(pack) },
    payment_intent_data: { metadata: { app: 'darkroom', accountId: account.id, pack: String(pack) } },
    success_url: `${config.publicBaseUrl}/app/billing?paid=1`,
    cancel_url: `${config.publicBaseUrl}/app/billing`,
  });
  return session.url;
}

/** Credit a paid session exactly once (unique on the session id). Credit = pack price, not the taxed total. */
async function creditSession(session) {
  if (session.metadata?.app !== 'darkroom') return; // another product's checkout on the shared Stripe account
  if (session.payment_status !== 'paid') return;
  const accountId = session.metadata?.accountId;
  const pack = Number(session.metadata?.pack);
  if (!UUID_RE.test(accountId || '') || !config.packs.includes(pack)) {
    console.error(`[stripe] session ${session.id} has no usable metadata`);
    return;
  }
  await tx(async (c) => {
    const { rows } = await c.query('SELECT id FROM accounts WHERE id = $1', [accountId]);
    if (!rows[0]) {
      console.error(`[stripe] session ${session.id} names unknown account ${accountId}`);
      return; // acknowledge: retrying can't fix it
    }
    const acct = await lockAccount(c, accountId);
    const entry = await addEntry(c, {
      accountId, kind: 'purchase', amountMicro: pack * 1e6, stripeSessionId: session.id, note: `$${pack} pack`,
    });
    if (entry && ['waitlist', 'trial'].includes(acct.plan)) {
      await c.query(`UPDATE accounts SET plan = 'paid', approved_at = coalesce(approved_at, now()) WHERE id = $1`, [accountId]);
    }
    if (entry) console.log(`[stripe] credited $${pack} to ${accountId} (${session.id})`);
  });
}

export function constructEvent(rawBody, signature) {
  if (!config.stripe.webhookSecret) throw new HttpError(503, 'billing_unavailable', 'Stripe webhook secret not configured');
  return stripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

export async function handleStripeEvent(event) {
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    await creditSession(event.data.object);
  }
}
