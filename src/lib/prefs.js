// User preferences (Settings → Preferences). Today: the mascot (on / quiet / off).
//
// Always stored in this browser (localStorage), so it works signed out. When signed in it is also kept on
// the account itself (Supabase auth user metadata: no table, no schema change), so it follows the person
// to other browsers. It is a display preference only; nothing private and nothing billing-related.
import { supabase, isConfigured } from './supabase.js';

export const MASCOT_KEY = 'sparkscribe.mascot';
export const MASCOT_MODES = ['on', 'quiet', 'off'];
const META_KEY = 'sparkscribe_mascot';

export function getMascotPref() {
  try { const v = localStorage.getItem(MASCOT_KEY); return MASCOT_MODES.includes(v) ? v : 'on'; } catch { return 'on'; }
}

// save locally, tell the mascot on this page, and (when signed in) keep it on the account
export async function setMascotPref(v, { sync = true } = {}) {
  if (!MASCOT_MODES.includes(v)) return;
  try { localStorage.setItem(MASCOT_KEY, v); } catch { /* private mode: this page only */ }
  window.dispatchEvent(new CustomEvent('sparkscribe:mascot-pref', { detail: v }));
  if (!sync || !isConfigured) return;
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session && data.session.user.user_metadata?.[META_KEY] !== v) await supabase.auth.updateUser({ data: { [META_KEY]: v } });
  } catch { /* stays saved in this browser */ }
}

// signed in on a browser that has a different value: the account's choice wins
export function adoptAccountPrefs(user) {
  const v = user?.user_metadata?.[META_KEY];
  if (MASCOT_MODES.includes(v) && v !== getMascotPref()) setMascotPref(v, { sync: false });
}
