// /pricing — the three plans, read from the database (billing_plans). Upgrading goes through the server
// (/api/billing), which picks the Stripe price itself; this page only sends "plus" or "pro".
import { isConfigured } from '../lib/supabase.js';
import { mountAccountMenu, getSession, esc } from '../lib/account.js';
import { loadPlans, getBillingStatus, startCheckout, price, perInterval, allowanceLabel } from '../lib/billing.js';

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

function render(plans) {
  $('plans').innerHTML = plans.map((p) => `
    <article class="plan-card${p.key === 'plus' ? ' featured' : ''}${status?.plan === p.key ? ' current' : ''}">
      <header><h2>${esc(p.name)}</h2><p class="plan-tag">${esc(p.tagline)}</p></header>
      <div class="plan-price"><span class="amt">${esc(price(p))}</span><span class="per">${esc(perInterval(p))}</span></div>
      <p class="plan-allow"><b>${esc(allowanceLabel(p.monthly_seconds))}</b> of transcription each month</p>
      <ul class="plan-list">
        <li>On-device transcription, audio never uploaded</li>
        <li>Private library with search</li>
        <li>Summaries, notes, Ask and study tools</li>
        ${p.billing_interval ? '<li>Cancel anytime in Manage Billing</li>' : '<li>No card needed</li>'}
      </ul>
      <div class="plan-cta">${buttonFor(p)}</div>
    </article>`).join('');
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
