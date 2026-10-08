// /account — current plan, this period's transcription usage, renewal / cancellation date, upgrade and
// Manage Billing. Everything shown comes from the server (billing_status); after Checkout the page waits for
// Stripe's webhook to confirm the subscription instead of assuming the payment worked.
import { isConfigured } from '../lib/supabase.js';
import { mountAccountMenu, requireUser, esc } from '../lib/account.js';
import { loadPlans, getBillingStatus, startCheckout, openPortal, price, perInterval, allowanceLabel, usageParts, usageLevel, durationText, dateText } from '../lib/billing.js';

const $ = (id) => document.getElementById(id);
let plans = [];
let status = null;
let busy = '';

function notice(html, kind = '') {
  const n = $('notice');
  n.className = `bill-notice ${kind}`;
  n.innerHTML = html;
  n.hidden = !html;
}

export function meterHtml(s) {
  const p = usageParts(Number(s.usedSeconds), s.monthlySeconds);
  const pct = Math.min(100, (Number(s.usedSeconds) / s.monthlySeconds) * 100);
  const level = usageLevel(Number(s.usedSeconds), s.monthlySeconds);
  return `<div class="meter ${level}" role="meter" aria-valuemin="0" aria-valuemax="${s.monthlySeconds}" aria-valuenow="${Math.round(Number(s.usedSeconds))}" aria-label="Transcription used this period">
      <div class="meter-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
      <div class="meter-text"><b>${esc(p.used)} / ${esc(p.total)} ${esc(p.unit)}</b><span>${esc(durationText(Number(s.remainingSeconds)))} left</span></div>
    </div>`;
}

function render() {
  const s = status;
  const plan = plans.find((p) => p.key === s.plan) || { name: s.planName, price_cents: 0 };
  const paid = s.plan !== 'free';
  const next = plans.find((p) => p.billing_interval && p.monthly_seconds > s.monthlySeconds);
  const level = usageLevel(Number(s.usedSeconds), s.monthlySeconds);
  let when;
  if (!paid) when = `Resets ${dateText(s.periodEnd)}`;
  else if (s.cancelAtPeriodEnd) when = `Your ${esc(plan.name)} plan remains active until ${dateText(s.periodEnd)}`;
  else when = `Renews ${dateText(s.periodEnd)}`;

  const warn = s.paymentProblem
    ? `<div class="bill-alert bad"><b>We couldn't process your payment.</b> ${paid ? `Your ${esc(plan.name)} plan stays active while Stripe retries.` : 'Your paid plan is paused until the payment goes through.'} Update your payment method in Manage Billing. Your recordings and everything you created are safe.</div>`
    : s.cancelAtPeriodEnd
      ? `<div class="bill-alert">Your subscription is canceled and won't renew. Until ${dateText(s.periodEnd)} you keep ${esc(allowanceLabel(s.monthlySeconds))} a month; after that you're on Free (${esc(allowanceLabel(plans.find((p) => p.is_default)?.monthly_seconds || 0))} a month). Nothing in your library is removed.</div>`
      : '';
  const limitMsg = level === 'high' && next
    ? `<p class="meter-hint">${Number(s.remainingSeconds) < 1 ? `You've used your ${esc(allowanceLabel(s.monthlySeconds))} for this ${paid ? 'billing period' : 'month'}.` : 'You’re almost out of transcription time.'} <b>${esc(next.name)}</b> includes ${esc(allowanceLabel(next.monthly_seconds))} a month.</p>`
    : level === 'warn' && next ? `<p class="meter-hint">You’ve used most of this ${paid ? 'period' : 'month'}’s time.</p>` : '';

  const upgradeBtn = next && s.upgradesAvailable
    ? `<button class="btn btn-primary" type="button" data-up="${esc(next.key)}"${busy ? ' disabled' : ''}>${busy === next.key ? 'Opening…' : `${paid ? 'Switch' : 'Upgrade'} to ${esc(next.name)} · ${esc(price(next))}${esc(perInterval(next))}`}</button>`
    : '';
  const manage = s.hasBillingAccount
    ? `<button class="btn ${paid ? 'btn-primary' : 'btn-ghost'}" type="button" data-act="portal"${busy ? ' disabled' : ''}>${busy === 'portal' ? 'Opening…' : 'Manage Billing'}</button>` : '';

  $('account').innerHTML = `
    ${warn}
    <div class="panel acct-card">
      <div class="ins-label">Current plan</div>
      <div class="acct-plan"><h2>${esc(plan.name)}</h2><span class="acct-price">${paid ? `${esc(price(plan))}${esc(perInterval(plan))}` : 'Free'}</span></div>
      <p class="acct-when">${when}</p>
      <div class="acct-actions">${s.paymentProblem ? manage + upgradeBtn : upgradeBtn + manage}<a class="btn btn-ghost" href="/pricing">Compare plans</a></div>
    </div>
    <div class="panel acct-card">
      <div class="ins-label">Transcription this ${paid ? 'billing period' : 'month'}</div>
      ${meterHtml(s)}
      ${limitMsg}
      <p class="acct-fine">Counts the length of recordings you transcribe. Summaries, notes, Ask, study tools, exports and opening old recordings don’t use time. ${s.meteringStarted ? '' : 'Usage tracking starts when plans launch; recordings you already have are never counted.'}</p>
    </div>
    ${s.testMode ? '<p class="acct-fine test">Test mode: Stripe test payments only. No real card is charged.</p>' : ''}`;
  $('account').querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => act(b.dataset.up, () => startCheckout(b.dataset.up))));
  $('account').querySelector('[data-act="portal"]')?.addEventListener('click', () => act('portal', openPortal));
}

async function act(name, fn) {
  if (busy) return;
  busy = name;
  render();
  try { await fn(); } catch (err) {
    busy = '';
    render();
    notice(esc(err.message || 'That didn’t work. Nothing was charged. Try again.'), 'bad');
  }
}

// After Checkout: wait for the webhook to confirm (never assume success from the return URL alone).
async function waitForActivation(before) {
  $('account').innerHTML = '<div class="panel acct-card activating"><span class="spin" aria-hidden="true"></span><div><b>Activating your subscription…</b><p>This usually takes a few seconds.</p></div></div>';
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, i < 5 ? 1500 : 3000));
    try {
      const s = await getBillingStatus();
      if (s.plan !== before) return s;
    } catch { /* keep waiting */ }
  }
  return null;
}

async function main() {
  if (isConfigured) mountAccountMenu($('accountSlot'));
  await requireUser();
  const q = new URLSearchParams(location.search);
  try {
    plans = await loadPlans();
    status = await getBillingStatus();
  } catch (err) {
    $('account').innerHTML = `<p class="bill-error">${esc(err.message || 'Your plan couldn’t be loaded.')} <a href="/account">Try again</a></p>`;
    return;
  }
  if (q.get('checkout') === 'success') {
    history.replaceState(null, '', '/account');
    if (status.plan === 'free') {
      const s = await waitForActivation(status.plan);
      if (s) { status = s; notice(`You're on <b>${esc(s.planName)}</b>. Thanks for subscribing!`, 'ok'); }
      else notice('Your payment is being confirmed. It can take a minute; refresh this page shortly. You won’t be charged twice.', 'warn');
    } else notice(`You're on <b>${esc(status.planName)}</b>.`, 'ok');
  } else if (q.get('changed') === '1') {
    history.replaceState(null, '', '/account');
    notice('Your plan change is being applied. It can take a few seconds to show here.', 'ok');
    setTimeout(async () => { try { status = await getBillingStatus(); render(); } catch {} }, 4000);
  }
  render();
}
main();
