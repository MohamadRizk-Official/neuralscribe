// Appearance (Settings → Preferences): System, Light or Dark.
//
// html[data-theme] is "light" or "dark" (what is shown); html[data-theme-pref] is the choice. The boot
// script below is inlined at the top of every page's <head> (vite.config.js), so the right theme is there
// before the first paint and nothing flashes. Like the mascot preference, the choice is kept in this browser
// and, when signed in, on the account (auth user metadata; no table).

export const THEME_KEY = 'sparkscribe.theme';
export const THEME_MODES = ['system', 'light', 'dark'];
export const THEME_DEFAULT = 'light'; // new visitors start in Light; System and Dark stay one click away

// Plain ES5 on purpose: it runs before any module, in every browser.
export const THEME_BOOT = `<script>(function(){var d=document.documentElement,p='light';try{p=localStorage.getItem('${THEME_KEY}')||'light'}catch(e){}
var t=p==='light'||p==='dark'?p:(window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');d.setAttribute('data-theme',t);d.setAttribute('data-theme-pref',p)})();</script>`;

const system = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;

export function getThemePref() {
  try { const v = localStorage.getItem(THEME_KEY); return THEME_MODES.includes(v) ? v : THEME_DEFAULT; } catch { return THEME_DEFAULT; }
}
export function resolvedTheme(pref = getThemePref()) {
  return pref === 'light' || pref === 'dark' ? pref : (system?.matches ? 'light' : 'dark');
}
export function applyTheme(pref = getThemePref()) {
  const d = document.documentElement;
  const t = resolvedTheme(pref);
  const changed = d.dataset.theme !== t;
  d.dataset.theme = t;
  d.dataset.themePref = pref;
  if (changed) window.dispatchEvent(new CustomEvent('sparkscribe:theme', { detail: t }));
}
// System follows the device live; another tab changing the setting follows too.
// (vite.config.js imports this file in Node for THEME_BOOT, hence the window check.)
if (typeof window !== 'undefined') {
  system?.addEventListener?.('change', () => { if (getThemePref() === 'system') applyTheme('system'); });
  window.addEventListener('storage', (e) => { if (e.key === THEME_KEY) applyTheme(); });
}
