// Settings: Account (who you're signed in as), Preferences (the mascot), Privacy (how your data is handled).
// Works signed out too: preferences are kept in this browser, and on the account when signed in.
import { mountAccountMenu, getSession, signOut, esc } from '../lib/account.js';
import { getMascotPref, setMascotPref, getThemePref, setThemePref } from '../lib/prefs.js';
import { mountMascot } from '../mascot/mascot.js';

const $ = (id) => document.getElementById(id);
let signedIn = false;

// ---------- account ----------
function renderAccount(session) {
  signedIn = !!session;
  const body = $('accountBody');
  if (!session) {
    body.innerHTML = `<div class="set-row-text"><h3>Not signed in</h3><p>Sign in to save transcripts to My Library and keep your preferences on every device.</p></div>
      <a class="btn btn-primary" href="/auth?next=%2Fsettings">Sign in</a>`;
    showSaved();
    return;
  }
  const u = session.user, meta = u.user_metadata || {};
  const name = meta.full_name || meta.name || '';
  body.innerHTML = `<div class="set-who"><b>${esc(name || u.email || 'Signed in')}</b>${name ? `<span>${esc(u.email || '')}</span>` : ''}</div>
    <div class="set-actions"><a class="btn btn-ghost" href="/library">My Library</a><button class="btn btn-ghost" type="button" id="signOutBtn">Sign out</button></div>`;
  $('signOutBtn').addEventListener('click', async () => { await signOut(); location.reload(); });
  showSaved();
}

// ---------- preferences: mascot ----------
const seg = $('mascotSeg');
function paint(v) {
  seg.querySelectorAll('[role="radio"]').forEach((b) => {
    const on = b.dataset.v === v;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  $('mascotModes').querySelectorAll('li').forEach((li) => li.classList.toggle('on', li.dataset.v === v));
}
let changedOnce = false;
function showSaved(changed) {
  if (changed) changedOnce = true;
  $('mascotSaved').textContent = changedOnce
    ? (signedIn ? 'Saved to your account.' : 'Saved in this browser.')
    : (signedIn ? 'Kept on your account, so it follows you to other browsers.' : 'Kept in this browser.');
}
function choose(v, focus) {
  paint(v);
  setMascotPref(v);
  showSaved(true);
  if (focus) seg.querySelector(`[data-v="${v}"]`)?.focus();
}
seg.addEventListener('click', (e) => { const b = e.target.closest('[role="radio"]'); if (b) choose(b.dataset.v); });
seg.addEventListener('keydown', (e) => {          // radio-group keys: arrows move and select
  const order = ['on', 'quiet', 'off'];
  const i = order.indexOf(getMascotPref());
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); choose(order[(i + 1) % 3], true); }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); choose(order[(i + 2) % 3], true); }
});
window.addEventListener('sparkscribe:mascot-pref', (e) => paint(e.detail));
paint(getMascotPref());

// ---------- preferences: appearance ----------
const themeSeg = $('themeSeg');
const THEMES = ['system', 'light', 'dark'];
function paintTheme(v) {
  themeSeg.querySelectorAll('[role="radio"]').forEach((b) => {
    const on = b.dataset.v === v;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
}
function chooseTheme(v, focus) {
  paintTheme(v);
  setThemePref(v);
  showSaved(true);
  if (focus) themeSeg.querySelector(`[data-v="${v}"]`)?.focus();
}
themeSeg.addEventListener('click', (e) => { const b = e.target.closest('[role="radio"]'); if (b) chooseTheme(b.dataset.v); });
themeSeg.addEventListener('keydown', (e) => {
  const i = THEMES.indexOf(getThemePref());
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); chooseTheme(THEMES[(i + 1) % 3], true); }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); chooseTheme(THEMES[(i + 2) % 3], true); }
});
paintTheme(getThemePref());

// ---------- start ----------
mountAccountMenu($('accountSlot'), { onChange: (s) => renderAccount(s) });
getSession().then(renderAccount);
mountMascot({ page: 'other' });
