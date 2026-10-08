// /pricing — the three plans, read from the database (billing_plans). Upgrading goes through the server
// (/api/billing), which picks the Stripe price itself; this page only sends "plus" or "pro".
import { isConfigured } from '../lib/supabase.js';
import { mountAccountMenu, getSession, esc } from '../lib/account.js';
import { loadPlans, getBillingStatus, startCheckout, price, perInterval } from '../lib/billing.js';

const $ = (id) => document.getElementById(id);
let session = null;
let status = null;
let busy = null;

function notice(html, kind = '') {
  const n = $('notice');
  n.className = `bill-notice ${kind}`;
  n.innerHTML = html;
  n.hidden = !html;
}

function buttonFor(p) {
  const current = status && status.plan === p.key;
  if (current) return '<span class="plan-current">Your current plan</span>';
  if (!p.billing_interval) {
    if (!session) return `<a class="btn btn-ghost" href="/auth?next=${encodeURIComponent('/')}">Start free</a>`;
    return status && status.plan !== 'free' ? '<span class="plan-note">Included when a paid plan ends</span>' : '<span class="plan-current">Your current plan</span>';
  }
  if (!session) return `<a class="btn btn-primary" href="/auth?next=${encodeURIComponent(`/pricing?plan=${p.key}`)}">Upgrade to ${esc(p.name)}</a>`;
  const label = status && status.plan !== 'free' ? `Switch to ${esc(p.name)}` : `Upgrade to ${esc(p.name)}`;
  return `<button class="btn btn-primary" type="button" data-plan="${esc(p.key)}"${busy ? ' disabled' : ''}>${busy === p.key ? 'Opening secure checkout…' : label}</button>`;
}

// Card copy per plan (presentation only). Names, prices and allowances always come from billing_plans; every
// plan has the same features, so cards only say who a plan suits. "{more}" becomes "20× more transcription",
// computed from the allowances. The full feature list lives once, in "Every plan includes".
const CARD_COPY = {
  free: { tag: 'For getting started', items: ['Full AI workspace', 'Searchable private Library', 'Summaries, Notes & Ask', 'Study & productivity tools', 'Exports'] },
  plus: { tag: 'For everyday use', badge: 'Recommended', items: ['Everything in {prev}', '{more}', 'Great for classes & meetings', 'Full Create tools', 'Cancel anytime'] },
  pro: { tag: 'For heavy recording', items: ['Everything in {prev}', '{more}', 'Built for long lectures & meetings', 'Full AI workspace', 'Cancel anytime'] },
};

// 3600 -> {num: "60", unit: "min"}, 72000 -> {num: "20", unit: "hr"}
function allowanceParts(seconds) {
  const h = seconds / 3600;
  return h >= 2 ? { num: String(Math.round(h * 10) / 10), unit: 'hr' } : { num: String(Math.round(seconds / 60)), unit: 'min' };
}
const ratio = (a, b) => `${Math.round((a / b) * 10) / 10}×`;

function render(plans) {
  $('plans').innerHTML = plans.map((p, i) => {
    const copy = CARD_COPY[p.key] || { tag: p.tagline, items: [] };
    const prev = plans[i - 1];
    const items = copy.items.map((t) => (prev ? t.replace('{prev}', prev.name).replace('{more}', `${ratio(p.monthly_seconds, prev.monthly_seconds)} more transcription`) : t));
    const a = allowanceParts(p.monthly_seconds);
    return `
    <article class="plan-card${copy.badge ? ' featured' : ''}${status?.plan === p.key ? ' current' : ''}">
      <div class="plan-title"><h2>${esc(p.name)}</h2>${copy.badge ? `<span class="plan-badge">${esc(copy.badge)}</span>` : ''}</div>
      <p class="plan-tag">${esc(copy.tag)}</p>
      <div class="plan-price"><span class="amt">${esc(price(p))}</span>${p.billing_interval ? `<span class="per">${esc(perInterval(p))}</span>` : ''}</div>
      <div class="plan-allow"><span class="num">${esc(a.num)}</span><span class="unit">${esc(a.unit)}</span><span class="of">/ month</span></div>
      <ul class="plan-list">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <div class="plan-cta">${buttonFor(p)}</div>
    </article>`;
  }).join('');
  $('plans').querySelectorAll('[data-plan]').forEach((b) => b.addEventListener('click', () => upgrade(b.dataset.plan, plans)));
}

async function upgrade(plan, plans) {
  if (busy) return;
  busy = plan;
  render(plans);
  notice('');
  try {
    await startCheckout(plan); // navigates to Stripe
  } catch (err) {
    busy = null;
    render(plans);
    notice(esc(err.message || "Checkout couldn't be opened. Nothing was charged. Try again."), 'bad');
  }
}

async function main() {
  if (isConfigured) mountAccountMenu($('accountSlot'));
  const q = new URLSearchParams(location.search);
  if (q.get('checkout') === 'canceled') notice('Checkout canceled. Nothing was charged and your plan hasn’t changed.');
  let plans;
  try { plans = await loadPlans(); } catch {
    $('plans').innerHTML = '<p class="bill-error">Plans couldn’t be loaded. Refresh to try again.</p>';
    return;
  }
  session = await getSession();
  if (session) {
    try { status = await getBillingStatus(); } catch { status = null; }
    if (status?.testMode) notice('<b>Test mode.</b> Stripe test payments only: no real card is charged.', 'test');
  }
  render(plans);
  // back from signing in after choosing a plan: continue to checkout
  const wanted = q.get('plan');
  if (session && wanted && plans.some((p) => p.key === wanted && p.billing_interval) && status?.plan === 'free') upgrade(wanted, plans);
}
main();
