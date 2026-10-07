// Shared helpers for the GitHub sign-in gate (used by middleware.js and api/auth/*).
// Sessions are stateless: a cookie holding { u: githubLogin, exp } signed with HMAC-SHA256.

export const COOKIE = 'ns_session';
export const STATE_COOKIE = 'ns_state';
export const SESSION_SECONDS = 7 * 24 * 60 * 60;

const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;

export function settings() {
  const host = process.env.CANONICAL_HOST || process.env.VERCEL_PROJECT_PRODUCTION_URL || '';
  return {
    host: host.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    secret: process.env.SESSION_SECRET || '',
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    repo: process.env.GITHUB_REPO || '',
  };
}

export const isConfigured = (s) => Boolean(s.host && s.secret && s.clientId && s.clientSecret && s.repo);

// ---- base64url / HMAC ----
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmacKey(secret) {
  return subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(login, secret, now = Date.now()) {
  const payload = b64url(enc.encode(JSON.stringify({ u: login, exp: Math.floor(now / 1000) + SESSION_SECONDS })));
  const sig = await subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

// Returns the GitHub login for a valid, unexpired session cookie value, otherwise null.
export async function verifySession(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  try {
    const ok = await subtle.verify('HMAC', await hmacKey(secret), unb64url(sig), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(unb64url(payload)));
    if (!data.u || typeof data.exp !== 'number' || data.exp * 1000 < now) return null;
    return data.u;
  } catch {
    return null;
  }
}

// ---- cookies ----
export function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return '';
}

export const setCookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export function randomHex(bytes = 16) {
  return [...globalThis.crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Only allow redirects back to a path on this site.
export function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/';
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- pages ----
const CSS = `
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;color:#eaf0ff;background:#04050d;
font-family:"Space Grotesk",system-ui,-apple-system,"Segoe UI",sans-serif;
background-image:radial-gradient(60vw 60vw at 10% -10%,rgba(14,165,198,.35),transparent 60%),radial-gradient(50vw 50vw at 100% 10%,rgba(109,77,255,.3),transparent 60%)}
.card{width:min(440px,100%);padding:34px 30px;border-radius:22px;border:1px solid rgba(140,160,255,.18);background:rgba(12,15,30,.78);backdrop-filter:blur(20px);box-shadow:0 24px 70px rgba(0,0,0,.5);text-align:center}
.mark{display:inline-flex;gap:3px;align-items:center;height:26px;margin-bottom:14px}
.mark i{width:3px;border-radius:2px;background:linear-gradient(120deg,#22d3ee,#a78bfa 55%,#f472b6)}
.mark i:nth-child(1){height:10px}.mark i:nth-child(2){height:18px}.mark i:nth-child(3){height:26px}.mark i:nth-child(4){height:16px}.mark i:nth-child(5){height:11px}
h1{font-size:28px;margin:0 0 8px;letter-spacing:-.02em}
p{color:#8a93b9;line-height:1.55;margin:0 0 22px;font-size:15px}
a.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:13px 18px;border-radius:12px;font-weight:600;font-size:15px;text-decoration:none;color:#04050c;background:linear-gradient(120deg,#22d3ee,#a78bfa 55%,#f472b6);box-shadow:0 8px 30px rgba(124,92,255,.35)}
a.btn:hover{filter:brightness(1.1)}a.link{display:inline-block;margin-top:16px;color:#8a93b9;font-size:13px}
svg{width:20px;height:20px;fill:currentColor}code{color:#eaf0ff}.err{color:#fb7185}
`;
const GITHUB_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.24 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg>';

export function page(title, bodyHtml, status = 200, extraHeaders = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body><main class="card"><div class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>${bodyHtml}</main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders } });
}

export const signInPage = (nextPath) =>
  page(
    'Sign in — NeuralScribe',
    `<h1>NeuralScribe</h1><p>This site is private. Sign in with the GitHub account that has access to the project.</p><a class="btn" href="/api/auth/login?next=${encodeURIComponent(nextPath)}">${GITHUB_ICON}Continue with GitHub</a>`,
    401,
  );

export const deniedPage = (login, repo) =>
  page(
    'No access — NeuralScribe',
    `<h1>No access</h1><p><code>@${esc(login)}</code> doesn't have write access to <code>${esc(repo)}</code> on GitHub. Ask the owner to add you as a collaborator, then try again.</p><a class="btn" href="/api/auth/login">${GITHUB_ICON}Try another account</a><br><a class="link" href="https://github.com/logout" rel="noopener">Sign out of GitHub first</a>`,
    403,
  );

export const notConfiguredPage = () =>
  page('Not configured — NeuralScribe', `<h1>Sign-in isn't set up</h1><p class="err">The site is locked, but its GitHub sign-in settings are missing, so nobody can get in yet. The owner needs to finish the setup.</p>`, 503);
