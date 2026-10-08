// Billing configuration: Stripe client, mode, plan catalogue and the plan <-> Stripe price mapping.
//
// Plans (names, prices, monthly allowances) come from the database table billing_plans, the single source of
// truth shared with the browser. Stripe price IDs differ between test and live mode, so they come from
// server environment variables named after the plan: STRIPE_PLUS_PRICE_ID, STRIPE_PRO_PRICE_ID, ...
// Secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, BILLING_DB_SECRET) are read here only, on the server.
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export class BillingError extends Error {
  constructor(message, { status = 400, code = 'bad_request', extra = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

let stripe = null;
export function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new BillingError('Billing is not available yet.', { status: 503, code: 'billing_not_configured' });
  if (!/^(sk|rk)_(test|live)_/.test(key)) throw new BillingError('Billing is not available yet.', { status: 503, code: 'billing_not_configured' });
  return (stripe ||= new Stripe(key, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: 'SparkScribe' } }));
}
// Test or live, decided by the key itself; subscriptions from the other mode never grant access.
export const isLiveMode = () => /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY || '');
export const billingConfigured = () => /^(sk|rk)_(test|live)_/.test(process.env.STRIPE_SECRET_KEY || '');

const supabaseUrl = () => process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = () => process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const noSession = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

// Queries as the signed-in user (RLS applies). `origin` is passed on so the database can tell which site the
// request came from (quota enforcement before launch is limited to the Preview site).
export function userClient(token, origin) {
  const headers = { Authorization: `Bearer ${token}` };
  if (origin) headers.Origin = origin;
  return createClient(supabaseUrl(), supabaseKey(), { global: { headers }, auth: noSession });
}

// The server-only billing functions in the database (billing_link_customer, billing_apply_subscription,
// billing_event_*). They run without a user session and are gated by BILLING_DB_SECRET.
export function billingDb() {
  const secret = process.env.BILLING_DB_SECRET;
  if (!secret || !supabaseUrl() || !supabaseKey()) throw new BillingError('Billing is not available yet.', { status: 503, code: 'billing_not_configured' });
  const sb = createClient(supabaseUrl(), supabaseKey(), { auth: noSession });
  return {
    async call(fn, args) {
      const { data, error } = await sb.rpc(fn, { p_secret: secret, ...args });
      if (error) {
        const e = new Error(error.message || 'billing database error');
        e.dbCode = error.code;
        throw e;
      }
      return data;
    },
  };
}

// ---------- plans ----------
let plansCache = null;
export async function loadPlans() {
  if (plansCache && plansCache.at > Date.now() - 60_000) return plansCache.plans;
  const sb = createClient(supabaseUrl(), supabaseKey(), { auth: noSession });
  const { data, error } = await sb.from('billing_plans').select('key, name, tagline, price_cents, currency, billing_interval, monthly_seconds, sort_order, is_default').eq('active', true).order('sort_order');
  if (error || !data?.length) throw new BillingError('Plans are unavailable right now. Try again.', { status: 503, code: 'plans_unavailable' });
  plansCache = { at: Date.now(), plans: data };
  return data;
}

const envName = (planKey) => `STRIPE_${planKey.toUpperCase()}_PRICE_ID`;
// The only way a Stripe price is chosen: from a plan key the server knows, never from the browser.
export function priceIdFor(planKey) {
  const id = process.env[envName(planKey)];
  return id && /^price_[A-Za-z0-9]+$/.test(id) ? id : null;
}
// Reverse: which plan does a Stripe price belong to? (unknown price -> null, grants nothing)
export async function planForPrice(priceId) {
  if (!priceId) return null;
  const plans = await loadPlans();
  return plans.find((p) => p.billing_interval && priceIdFor(p.key) === priceId)?.key || null;
}

// Where Stripe sends people back to. Only this site's own hosts; never a value taken from the request body.
export function appOrigin(req) {
  if (process.env.APP_URL && /^https:\/\/[a-z0-9.-]+$/i.test(process.env.APP_URL)) return process.env.APP_URL;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return `http://${host}`;
  if (/^sparkscribe[a-z0-9-]*\.vercel\.app$/.test(host)) return `https://${host}`;
  throw new BillingError('Billing is not available on this site.', { status: 400, code: 'bad_origin' });
}

// Safe structured log line: ids and outcomes only (never keys, card data, emails or checkout URLs).
export function billingLog(event, fields = {}) {
  console.log(`[billing] ${JSON.stringify({ event, ...fields })}`);
}
