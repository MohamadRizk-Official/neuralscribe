// Session helpers + the small account area in the top bar (shared by every page).
import { supabase, isConfigured } from './supabase.js';
import { adoptAccountPrefs } from './prefs.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Only ever redirect to a path on this site.
export function safeNext(value, fallback = '/') {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : fallback;
}

export const currentPath = () => location.pathname + location.search;

// Fast, local check (reads the stored session). Good for UI state.
export async function getSession() {
  if (!isConfigured) return null;
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

// Verified with the auth server. Use before showing private pages.
// A stored session the server rejects (expired, revoked, user deleted) is cleared from this browser,
// otherwise the sign-in page would think you're signed in and bounce you back in a loop.
export async function getUser() {
  if (!isConfigured) return null;
  const { data, error } = await supabase.auth.getUser();
  if (!error && data.user) return data.user;
  const { data: local } = await supabase.auth.getSession();
  if (local.session) await supabase.auth.signOut({ scope: 'local' });
  return null;
}

// Private pages: send signed-out visitors to sign in, then back here.
export async function requireUser() {
  const user = await getUser();
  if (!user) {
    location.replace(`/auth?next=${encodeURIComponent(currentPath())}`);
    return new Promise(() => {}); // stop the page while navigating
  }
  return user;
}

export async function signOut() {
  if (!isConfigured) return;
  await supabase.auth.signOut();
}

async function loadProfile(user) {
  const { data } = await supabase.from('profiles').select('display_name, avatar_url').eq('id', user.id).maybeSingle();
  const meta = user.user_metadata || {};
  return {
    name: data?.display_name || meta.full_name || meta.name || '',
    avatar: data?.avatar_url || meta.avatar_url || '',
    email: user.email || '',
  };
}

const GEAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>';

function initialsOf(nameOrEmail) {
  const parts = String(nameOrEmail || '?').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

// Renders "Sign in" or the avatar menu into `slot`, and keeps it in sync with auth changes.
export function mountAccountMenu(slot, { onChange } = {}) {
  if (!slot || !isConfigured) return;
  slot.classList.add('account');
  slot.innerHTML = '<span class="acct-skel" aria-hidden="true"></span>';

  let menu = null;
  const close = () => { menu?.remove(); menu = null; document.removeEventListener('pointerdown', outside); slot.querySelector('.acct-btn')?.setAttribute('aria-expanded', 'false'); };
  const outside = (e) => { if (menu && !menu.contains(e.target) && !slot.contains(e.target)) close(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  async function render(session) {
    close();
    if (!session) {
      const onAuthPage = location.pathname.startsWith('/auth');
      const gear = location.pathname.startsWith('/settings') ? '' : `<a class="acct-gear" href="/settings" aria-label="Settings" title="Settings">${GEAR}</a>`;
      slot.innerHTML = onAuthPage ? '' : `${gear}<a class="acct-signin" href="/auth?next=${encodeURIComponent(currentPath())}">Sign in</a>`;
      return;
    }
    adoptAccountPrefs(session.user);
    const p = await loadProfile(session.user);
    const label = p.name || p.email;
    slot.innerHTML = `<button class="acct-btn" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu">
      ${p.avatar ? `<img src="${esc(p.avatar)}" alt="" referrerpolicy="no-referrer" />` : `<span>${esc(initialsOf(label))}</span>`}
    </button>`;
    const btn = slot.querySelector('.acct-btn');
    btn.addEventListener('click', () => {
      if (menu) return close();
      btn.setAttribute('aria-expanded', 'true');
      menu = document.createElement('div');
      menu.className = 'acct-menu';
      menu.setAttribute('role', 'menu');
      menu.innerHTML = `
        <div class="acct-head"><span class="acct-avatar" aria-hidden="true">${p.avatar ? `<img src="${esc(p.avatar)}" alt="" referrerpolicy="no-referrer" />` : esc(initialsOf(label))}</span><span class="acct-who">${p.name ? `<b>${esc(p.name)}</b>` : ''}<span>${esc(p.email)}</span></span></div>
        <a role="menuitem" href="/settings#account"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1-3.6 3.8-5.5 7-5.5s6 1.9 7 5.5"/></svg>Account</a>
        <a role="menuitem" href="/settings#preferences">${GEAR}Settings</a>
        <a role="menuitem" href="/library"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h6v14H4zM14 5h6v14h-6z"/></svg>My Library</a>
        <hr />
        <button role="menuitem" type="button" data-signout><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 12H4m0 0 4-4m-4 4 4 4M13 5h6v14h-6"/></svg>Sign out</button>`;
      menu.querySelector('[data-signout]').addEventListener('click', async () => {
        await signOut();
        if (/^\/(library|transcript)/.test(location.pathname)) location.replace('/');
      });
      slot.appendChild(menu);
      menu.querySelector('[role="menuitem"]')?.focus();
      // arrow keys move between items (a real menu, not a tooltip)
      menu.addEventListener('keydown', (e) => {
        const items = [...menu.querySelectorAll('[role="menuitem"]')];
        const i = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
        if (e.key === 'Escape') { close(); btn.focus(); }
      });
      setTimeout(() => document.addEventListener('pointerdown', outside), 0);
    });
  }

  getSession().then((s) => { render(s); onChange?.(s); });
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'INITIAL_SESSION') return; // handled by getSession above
    // defer: never await Supabase calls inside this callback (it can deadlock the client)
    setTimeout(() => { render(session); onChange?.(session); }, 0);
  });
}
