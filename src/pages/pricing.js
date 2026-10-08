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

// Marketing copy per plan (presentation only). Names, prices and allowances always come from billing_plans;
// every plan has the same features, so the copy only describes who it suits and how much time it includes.
const CARD_COPY = {
  // items: always shown; extra: shown on wider screens (phones get the shared "Every plan includes" list below)
  free: {
    tag: 'For getting started',
    items: ['AI Summary, organized Notes and Ask', 'Study guides, flashcards, quizzes and drafts', 'No card required'],
    extra: ['Private, searchable Library', 'PDF, Word and Markdown exports'],
  },
  plus: {
    tag: 'For classes, meetings & everyday use',
    badge: 'Recommended',
    items: ['Study Guides, Flashcards & Quizzes', 'Meeting Recaps, Action Plans & Drafts', 'Manage or cancel anytime'],
    extra: ['Searchable recording Library', 'PDF, Word & Markdown exports'],
  },
  pro: {
    tag: 'For heavy recording & serious workflows',
    items: ['Room for long lectures, interviews and back-to-back meetings', 'Every AI and Create tool', 'Manage or cancel anytime'],
    extra: ['A searchable personal knowledge Library'],
  },
};

// 3600 -> {num: "60", unit: "minutes"}, 72000 -> {num: "20", unit: "hours"}
function allowanceParts(seconds) {
  const h = seconds / 3600;
  if (h >= 2) return { num: String(Math.round(h * 10) / 10), unit: 'hours' };
  return { num: String(Math.round(seconds / 60)), unit: 'minutes' };
}
const times = (a, b) => `${Math.round((a / b) * 10) / 10}×`;

function render(plans) {
  $('plans').innerHTML = plans.map((p, i) => {
    const copy = CARD_COPY[p.key] || { tag: p.tagline, items: [] };
    const prev = plans[i - 1];
    const lead = prev ? `Everything in ${esc(prev.name)}, with <b>${esc(times(p.monthly_seconds, prev.monthly_seconds))}</b> the transcription time` : 'The full SparkScribe AI workspace';
    const a = allowanceParts(p.monthly_seconds);
    return `
    <article class="plan-card${copy.badge ? ' featured' : ''}${status?.plan === p.key ? ' current' : ''}">
      <header class="plan-head">
        <div class="plan-title"><h2>${esc(p.name)}</h2>${copy.badge ? `<span class="plan-badge">${esc(copy.badge)}</span>` : ''}</div>
        <p class="plan-tag">${esc(copy.tag)}</p>
      </header>
      <div class="plan-price"><span class="amt">${esc(price(p))}</span><span class="per">${esc(perInterval(p))}</span></div>
      <div class="plan-allow${p.billing_interval ? ' hours' : ''}">
        <span class="num">${esc(a.num)}</span><span class="unit">${esc(a.unit)}</span><span class="of">of transcription<br />per month</span>
      </div>
      <p class="plan-lead">${lead}</p>
      <ul class="plan-list">${[...copy.items.slice(0, -1).map((t) => [t, '']), ...(copy.extra || []).map((t) => [t, ' class="x"']), ...copy.items.slice(-1).map((t) => [t, ''])].map(([t, c]) => `<li${c}>${esc(t)}</li>`).join('')}</ul>
      <a class="plan-more" href="#inclTitle">Includes the full AI workspace · <u>See everything</u></a>
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
