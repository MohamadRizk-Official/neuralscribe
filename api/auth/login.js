// Step 1: send the visitor to GitHub to sign in.
import { STATE_COOKIE, settings, isConfigured, randomHex, safeNext, setCookie, notConfiguredPage } from '../../lib/auth.js';

export default {
  fetch(request) {
    const s = settings();
    if (!isConfigured(s)) return notConfiguredPage();

    const url = new URL(request.url);
    // Always sign in on the canonical host, so the cookie we set there is the one the gate checks.
    if (url.host !== s.host) {
      return new Response(null, { status: 307, headers: { location: `https://${s.host}/api/auth/login${url.search}` } });
    }

    const state = randomHex(16);
    const next = safeNext(url.searchParams.get('next'));
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', s.clientId);
    authorize.searchParams.set('redirect_uri', `https://${s.host}/api/auth/callback`);
    authorize.searchParams.set('scope', 'read:user');
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('allow_signup', 'false');

    return new Response(null, {
      status: 302,
      headers: {
        location: authorize.toString(),
        // state is checked on the way back; `next` rides along so we can return to the right page
        'set-cookie': setCookie(STATE_COOKIE, `${state}|${next}`, 600),
        'cache-control': 'no-store',
      },
    });
  },
};
