// Tells the page who is signed in (the session cookie is HttpOnly, so scripts can't read it).
import { COOKIE, getCookie, verifySession, settings } from '../../lib/auth.js';

export default {
  async fetch(request) {
    const login = await verifySession(getCookie(request, COOKIE), settings().secret);
    return new Response(JSON.stringify(login ? { login } : {}), {
      status: login ? 200 : 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  },
};
