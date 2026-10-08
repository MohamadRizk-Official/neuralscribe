// Plans, usage and billing for the browser. Display only: what a user may actually do is decided on the
// server and in the database (entitlements), never here. Plan names, prices and allowances come from the
// database table billing_plans, the same source the server uses.
import { supabase, isConfigured } from './supabase.js';

let plansPromise = null;
export function loadPlans() {
  if (!isConfigured) return Promise.resolve([]);
  return (plansPromise ||= supabase.from('billing_plans')
    .select('key, name, tagline, price_cents, currency, billing_interval, monthly_seconds, sort_order, is_default')
    .eq('active', true).order('sort_order')
    .then(({ data, error }) => { if (error) { plansPromise = null; throw error; } return data; }));
}

export class BillingApiError extends Error {
  constructor(message, code, status, extra = {}) { super(message); this.code = code; this.status = status; Object.assign(this, extra); }
}

async function call(action, payload = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new BillingApiError('Sign in to continue.', 'unauthorized', 401);
  let res;
  try {
    res = await fetch('/api/billing', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ action, ...payload }) });
  } catch {
    throw new BillingApiError("Couldn't reach SparkScribe. Check your connection and try again.", 'network', 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new BillingApiError(body.message || 'Something went wrong. Try again.', body.error || 'error', res.status, body);
  return body;
}

export const getBillingStatus = () => call('status');
export const authorizeTranscription = (durationSeconds) => call('authorize', { durationSeconds });
export async function startCheckout(plan) { const r = await call('checkout', { plan }); location.assign(r.url); return r; }
export async function openPortal() { const r = await call('portal'); location.assign(r.url); return r; }

// ---------- formatting (exact seconds are stored; these round only for display) ----------
export const price = (p) => (p.price_cents ? `$${(p.price_cents / 100).toFixed(2)}` : '$0');
export const perInterval = (p) => (p.billing_interval ? `/${p.billing_interval}` : '/month');

// "60 minutes" / "20 hours"
export function allowanceLabel(seconds) {
  const h = seconds / 3600;
  return h >= 2 ? `${trim(h)} hours` : `${Math.round(seconds / 60)} minutes`;
}
const trim = (n) => (Math.round(n * 10) / 10).toString();

// Usage in the plan's own unit: "41 / 60 min" for small plans, "8.2 / 20 hr" for hour plans.
export function usageParts(used, total) {
  if (total >= 7200) return { used: trim(Math.max(0, used) / 3600), total: trim(total / 3600), unit: 'hr', unitLong: 'hours' };
  // never show "60 / 60" while a few seconds are still left
  const u = used > 0 && used < 60 ? 1 : Math.floor(Math.max(0, used) / 60);
  return { used: String(Math.min(u, Math.round(total / 60))), total: String(Math.round(total / 60)), unit: 'min', unitLong: 'minutes' };
}
export const usageText = (used, total) => { const p = usageParts(used, total); return `${p.used} / ${p.total} ${p.unit}`; };

// "8 minutes" / "1 hour 5 minutes" for remaining time and recording lengths
export function durationText(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h && m) return `${h} hour${h === 1 ? '' : 's'} ${m} minute${m === 1 ? '' : 's'}`;
  if (h) return `${h} hour${h === 1 ? '' : 's'}`;
  if (s < 60) return s <= 0 ? '0 minutes' : 'less than a minute';
  return `${m} minute${m === 1 ? '' : 's'}`;
}

export const dateText = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });

// calm until it matters: 80% -> "warn", 95% or out -> "high"
export function usageLevel(used, total) {
  const r = total ? used / total : 0;
  return r >= 0.95 ? 'high' : r >= 0.8 ? 'warn' : 'ok';
}
