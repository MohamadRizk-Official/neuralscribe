// Billing operations. Every decision about what a user may do comes from the database (entitlements) and
// Stripe (subscriptions); nothing the browser says about its plan is trusted.
//
//   getStatus()          the signed-in user's plan, usage and renewal (from public.billing_status())
//   authorize()          may this user start transcribing a recording of N seconds? (checked before work starts;
//                        the database re-checks when the transcription is saved)
//   createCheckout()     Stripe Checkout for Free -> Plus/Pro; a plan change for paid users (Customer Portal)
//   createPortal()       Stripe Customer Portal for the signed-in user's own customer
//   handleEvent()        a verified Stripe webhook event -> synchronized subscription state
import { getStripe, isLiveMode, billingDb, loadPlans, priceIdFor, planForPrice, BillingError, billingLog } from './config.js';

const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);
// SparkScribe's own Customer Portal settings (plans, cancellation at period end), if configured
const portalConfig = () => (/^bpc_[A-Za-z0-9]+$/.test(process.env.STRIPE_PORTAL_CONFIGURATION_ID || '') ? { configuration: process.env.STRIPE_PORTAL_CONFIGURATION_ID } : {});
const MAX_SECONDS = 360_000;

export async function getStatus(sb) {
  const { data, error } = await sb.rpc('billing_status');
  if (error || !data) throw new BillingError("Your plan couldn't be loaded. Try again.", { status: 503, code: 'status_unavailable' });
  return data;
}

// ---------- quota ----------
export async function authorize(sb, durationSeconds) {
  const seconds = Number(durationSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_SECONDS) throw new BillingError('Invalid recording length.', { status: 400, code: 'bad_request' });
  const s = await getStatus(sb);
  const plans = await loadPlans();
  const next = plans.find((p) => p.billing_interval && p.monthly_seconds > s.monthlySeconds) || null;
  const base = { plan: s.plan, remainingSeconds: Number(s.remainingSeconds), monthlySeconds: s.monthlySeconds, periodEnd: s.periodEnd, upgradeTo: next?.key || null };
  if (!s.enforced) return { ok: true, enforced: false, ...base };
  // one second of tolerance, matching the database check
  if (seconds > Number(s.remainingSeconds) + 1) {
    billingLog('usage_rejected', { plan: s.plan, requested: Math.round(seconds), remaining: Math.round(Number(s.remainingSeconds)) });
    return { ok: false, enforced: true, reason: Number(s.remainingSeconds) < 1 ? 'limit_reached' : 'too_long', requestedSeconds: seconds, ...base };
  }
  return { ok: true, enforced: true, ...base };
}

// ---------- customer ----------
// One Stripe customer per SparkScribe account. The database keeps the mapping; a concurrent second request
// gets the customer the first one linked, and its own extra customer is removed.
async function ensureCustomer(sb, user) {
  const stripe = getStripe();
  const live = isLiveMode();
  const { data: row } = await sb.from('subscriptions').select('stripe_customer_id, livemode').eq('user_id', user.id).maybeSingle();
  if (row?.stripe_customer_id && row.livemode === live) return row.stripe_customer_id;
  const created = await stripe.customers.create(
    { email: user.email || undefined, metadata: { supabase_user_id: user.id } },
    { idempotencyKey: `sparkscribe-customer-${user.id}-${live ? 'live' : 'test'}` },
  );
  const linked = await billingDb().call('billing_link_customer', { p_user: user.id, p_customer: created.id, p_livemode: live });
  if (linked !== created.id) {
    await stripe.customers.del(created.id).catch(() => {});
    return linked;
  }
  billingLog('customer_linked', { user: user.id });
  return linked;
}

// The customer's current subscription that still gives (or is about to give) access, straight from Stripe.
async function liveSubscription(customer) {
  const subs = await getStripe().subscriptions.list({ customer, status: 'all', limit: 10 });
  return subs.data.find((s) => PAID_STATUSES.has(s.status)) || subs.data.find((s) => s.status === 'incomplete') || null;
}

// ---------- Checkout / plan change ----------
export async function createCheckout(sb, user, planKey, origin) {
  const stripe = getStripe();
  const plans = await loadPlans();
  const plan = plans.find((p) => p.key === planKey && p.billing_interval);
  if (!plan) throw new BillingError('Choose Plus or Pro.', { status: 400, code: 'bad_plan' });
  const price = priceIdFor(plan.key);
  if (!price) throw new BillingError('This plan is not available yet.', { status: 503, code: 'billing_not_configured' });

  const customer = await ensureCustomer(sb, user);
  const current = await liveSubscription(customer);
  if (current && PAID_STATUSES.has(current.status)) {
    const item = current.items.data[0];
    if (item?.price?.id === price) throw new BillingError(`You're already on ${plan.name}.`, { status: 409, code: 'already_on_plan' });
    // Already paying: change the plan through the Customer Portal, where Stripe shows the prorated amount and
    // the user confirms. No second subscription is ever created.
    const session = await stripe.billingPortal.sessions.create({
      customer,
      ...portalConfig(),
      return_url: `${origin}/account`,
      flow_data: {
        type: 'subscription_update_confirm',
        subscription_update_confirm: { subscription: current.id, items: [{ id: item.id, price, quantity: 1 }] },
        after_completion: { type: 'redirect', redirect: { return_url: `${origin}/account?changed=1` } },
      },
    });
    billingLog('plan_change_session', { user: user.id, to: plan.key });
    return { url: session.url, kind: 'change' };
  }
  if (current?.status === 'incomplete') {
    // an earlier checkout that never completed payment: let Stripe expire it rather than stacking another
    await stripe.subscriptions.cancel(current.id).catch(() => {});
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: user.id,
    line_items: [{ price, quantity: 1 }],
    metadata: { supabase_user_id: user.id, plan: plan.key },
    subscription_data: { metadata: { supabase_user_id: user.id, plan: plan.key } },
    success_url: `${origin}/account?checkout=success`,
    cancel_url: `${origin}/pricing?checkout=canceled`,
    allow_promotion_codes: false,
  });
  billingLog('checkout_session', { user: user.id, plan: plan.key });
  return { url: session.url, kind: 'checkout' };
}

export async function createPortal(sb, user, origin) {
  const live = isLiveMode();
  const { data: row } = await sb.from('subscriptions').select('stripe_customer_id, livemode').eq('user_id', user.id).maybeSingle();
  if (!row?.stripe_customer_id || row.livemode !== live) throw new BillingError("You don't have billing to manage yet.", { status: 404, code: 'no_billing_account' });
  const session = await getStripe().billingPortal.sessions.create({ customer: row.stripe_customer_id, ...portalConfig(), return_url: `${origin}/account` });
  billingLog('portal_session', { user: user.id });
  return { url: session.url };
}

// ---------- webhooks ----------
const ts = (s) => (s ? new Date(s * 1000).toISOString() : null);
const idOf = (x) => (typeof x === 'string' ? x : x?.id || null);

// Store a subscription exactly as Stripe reports it now (fetched fresh, so late or out-of-order events can't
// leave stale state behind).
async function syncSubscription(subscriptionId) {
  const sub = await getStripe().subscriptions.retrieve(subscriptionId);
  const item = sub.items?.data?.[0];
  const price = item?.price?.id || null;
  const plan = await planForPrice(price);
  const metaUser = sub.metadata?.supabase_user_id || null;
  const userId = await billingDb().call('billing_apply_subscription', {
    p_customer: idOf(sub.customer),
    p_meta_user: /^[0-9a-f-]{36}$/i.test(metaUser || '') ? metaUser : null,
    p_subscription: sub.id,
    p_status: sub.status,
    p_plan: plan,
    p_price: price,
    p_livemode: Boolean(sub.livemode),
    p_period_start: ts(item?.current_period_start ?? sub.current_period_start),
    p_period_end: ts(item?.current_period_end ?? sub.current_period_end),
    p_cancel_at_period_end: Boolean(sub.cancel_at_period_end || (sub.cancel_at && sub.cancel_at <= (item?.current_period_end ?? 0))),
    p_cancel_at: ts(sub.cancel_at),
    p_canceled_at: ts(sub.canceled_at),
  });
  return { userId, customer: idOf(sub.customer), subscription: sub.id, plan: plan || 'unknown_price', status: sub.status };
}

// Outcomes that will never succeed on retry: recorded, acknowledged, and never grant access.
const FINAL_REFUSALS = /unknown_customer|user_mismatch|mode_mismatch|customer_belongs_to_another_user|unknown_user/;

export async function handleEvent(event) {
  const db = billingDb();
  if (Boolean(event.livemode) !== isLiveMode()) {
    billingLog('webhook_ignored', { id: event.id, type: event.type, reason: 'other_mode' });
    return { status: 200, body: { received: true, ignored: 'other_mode' } };
  }
  const begin = await db.call('billing_event_begin', { p_event_id: event.id, p_type: event.type, p_livemode: Boolean(event.livemode) });
  if (begin !== 'new') {
    billingLog('webhook_duplicate', { id: event.id, type: event.type });
    return { status: 200, body: { received: true, duplicate: true } };
  }
  const obj = event.data?.object || {};
  let out = { result: 'ignored', detail: null, userId: null, customer: idOf(obj.customer), subscription: null };
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        if (obj.mode !== 'subscription' || !obj.subscription) break;
        const uid = obj.client_reference_id || obj.metadata?.supabase_user_id;
        if (!/^[0-9a-f-]{36}$/i.test(uid || '')) throw new Error('user_mismatch: checkout without a user');
        // the customer was linked when Checkout was created; this refuses one linked to a different user
        const linked = await db.call('billing_link_customer', { p_user: uid, p_customer: idOf(obj.customer), p_livemode: Boolean(event.livemode) });
        if (linked !== idOf(obj.customer)) throw new Error('customer_belongs_to_another_user');
        const r = await syncSubscription(idOf(obj.subscription));
        out = { ...out, result: 'synced', detail: `${r.plan}/${r.status}`, userId: r.userId, subscription: r.subscription };
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed': {
        const r = await syncSubscription(obj.id);
        out = { ...out, result: 'synced', detail: `${r.plan}/${r.status}`, userId: r.userId, subscription: r.subscription };
        break;
      }
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.payment_action_required': {
        const subId = idOf(obj.parent?.subscription_details?.subscription) || idOf(obj.subscription);
        if (!subId) break;
        const r = await syncSubscription(subId);
        out = { ...out, result: event.type === 'invoice.paid' ? 'synced' : 'payment_problem', detail: `${r.plan}/${r.status}`, userId: r.userId, subscription: r.subscription };
        break;
      }
      default:
        break;
    }
  } catch (err) {
    const msg = String(err?.message || 'error');
    const refusal = FINAL_REFUSALS.exec(msg)?.[0];
    await db.call('billing_event_finish', { p_event_id: event.id, p_result: refusal ? `refused:${refusal}` : 'error', p_detail: refusal || 'processing failed', p_user: null, p_customer: out.customer, p_subscription: out.subscription }).catch(() => {});
    billingLog('webhook_result', { id: event.id, type: event.type, result: refusal ? `refused:${refusal}` : 'error' });
    // a refusal is final (200, no retry); anything else is retried by Stripe
    return refusal ? { status: 200, body: { received: true, refused: refusal } } : { status: 500, body: { error: 'processing_failed' } };
  }
  await db.call('billing_event_finish', { p_event_id: event.id, p_result: out.result, p_detail: out.detail, p_user: out.userId, p_customer: out.customer, p_subscription: out.subscription });
  billingLog('webhook_result', { id: event.id, type: event.type, result: out.result, user: out.userId, detail: out.detail });
  return { status: 200, body: { received: true } };
}
