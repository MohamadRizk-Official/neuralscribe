// POST /api/stripe-webhook  (called by Stripe only)
// The raw body is verified against the Stripe-Signature header with STRIPE_WEBHOOK_SECRET before anything is
// read from it. Unsigned, badly signed, stale or other-mode events change nothing.
import { getStripe, BillingError, billingLog } from '../server/billing/config.js';
import { handleEvent } from '../server/billing/service.js';

const MAX_BODY = 512 * 1024;

// Read the exact bytes Stripe signed. (req.body is deliberately never touched: on Vercel it's a getter that
// would parse the JSON and lose the raw bytes the signature covers.)
async function rawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new BillingError('Too large.', { status: 413, code: 'too_large' });
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

const reply = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'method_not_allowed' });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.STRIPE_SECRET_KEY) return reply(res, 503, { error: 'billing_not_configured' });
  const signature = req.headers['stripe-signature'];
  if (!signature) return reply(res, 400, { error: 'missing_signature' });
  let event;
  try {
    const body = await rawBody(req);
    // default tolerance: 5 minutes, so a captured request can't be replayed later
    event = getStripe().webhooks.constructEvent(body, signature, secret);
  } catch {
    billingLog('webhook_rejected', { reason: 'invalid_signature' });
    return reply(res, 400, { error: 'invalid_signature' });
  }
  try {
    const r = await handleEvent(event);
    return reply(res, r.status, r.body);
  } catch (err) {
    billingLog('webhook_result', { id: event.id, type: event.type, result: 'error', kind: err?.type || err?.name || 'Error' });
    return reply(res, 500, { error: 'processing_failed' });
  }
}
