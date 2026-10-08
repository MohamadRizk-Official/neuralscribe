// POST /api/billing { action, ... }   (signed-in users only)
//   action "status"                     -> plan, usage, renewal date
//   action "authorize", durationSeconds -> may a recording this long be transcribed now?
//   action "checkout", plan: "plus"|"pro" -> { url } Stripe Checkout (or a plan change for paid users)
//   action "portal"                     -> { url } Stripe Customer Portal
// The user is always the one in the verified session token; the browser never names a user, customer,
// price or plan status. Only a plan key is accepted, and the server maps it to its own Stripe price.
import { readJson, sendJson } from '../server/http.js';
import { userClient, appOrigin, BillingError, billingLog, billingConfigured, isLiveMode, priceIdFor, loadPlans } from '../server/billing/config.js';
import { getStatus, authorize, createCheckout, createPortal } from '../server/billing/service.js';

async function signedIn(req) {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  if (!token) throw new BillingError('Sign in to continue.', { status: 401, code: 'unauthorized' });
  const sb = userClient(token, req.headers.origin);
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) throw new BillingError('Your session has expired. Sign in again.', { status: 401, code: 'unauthorized' });
  return { sb, user: { id: data.user.id, email: data.user.email || null } };
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw new BillingError('Method not allowed.', { status: 405, code: 'method_not_allowed' });
    const body = await readJson(req);
    const { sb, user } = await signedIn(req);
    switch (body.action) {
      case 'status':
        return sendJson(res, 200, {
          ...(await getStatus(sb)),
          // whether upgrades can be bought here, and whether they are Stripe test payments (Preview)
          upgradesAvailable: billingConfigured() && (await loadPlans()).filter((p) => p.billing_interval).every((p) => priceIdFor(p.key)),
          testMode: billingConfigured() && !isLiveMode(),
        });
      case 'authorize':
        return sendJson(res, 200, await authorize(sb, body.durationSeconds));
      case 'checkout':
        return sendJson(res, 200, await createCheckout(sb, user, String(body.plan || ''), appOrigin(req)));
      case 'portal':
        return sendJson(res, 200, await createPortal(sb, user, appOrigin(req)));
      default:
        throw new BillingError('Unknown action.', { status: 400, code: 'bad_request' });
    }
  } catch (err) {
    if (err instanceof BillingError) return sendJson(res, err.status, { error: err.code, message: err.message, ...(err.extra || {}) });
    // Stripe or network failure: a plain message for the user, only the error class in the logs
    billingLog('error', { action: 'api', kind: err?.type || err?.name || 'Error' });
    return sendJson(res, 502, { error: 'billing_unavailable', message: "Billing isn't responding right now. Nothing was charged. Try again in a moment." });
  }
}
