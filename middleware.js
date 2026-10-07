// Runs before every request (including static files). Lets the request through only if it carries a
// valid session cookie created by /api/auth/callback; otherwise shows the "Sign in with GitHub" page.
import { next } from '@vercel/functions';
import { COOKIE, getCookie, verifySession, settings, isConfigured, signInPage, notConfiguredPage } from './lib/auth.js';

export const config = {
  runtime: 'nodejs',
  // everything except the sign-in endpoints themselves
  matcher: ['/((?!api/auth/).*)'],
};

export default async function middleware(request) {
  const s = settings();
  if (!isConfigured(s)) return notConfiguredPage(); // fail closed

  const url = new URL(request.url);

  // Sign-in only works on the canonical host (the OAuth callback URL is fixed), so send other
  // hostnames (e.g. per-deployment *.vercel.app URLs) there first.
  if (url.host !== s.host) {
    return new Response(null, { status: 307, headers: { location: `https://${s.host}${url.pathname}${url.search}`, 'cache-control': 'no-store' } });
  }

  const login = await verifySession(getCookie(request, COOKIE), s.secret);
  if (login) return next({ headers: { 'cache-control': 'private, no-cache', 'x-robots-tag': 'noindex' } });

  const wantsPage = request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html');
  if (wantsPage) return signInPage(url.pathname + url.search);
  return new Response('Sign in required', { status: 401, headers: { 'cache-control': 'no-store' } });
}
