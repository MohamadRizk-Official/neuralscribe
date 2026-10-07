// Clears the session cookie and returns to the sign-in page.
import { COOKIE, setCookie } from '../../lib/auth.js';

export default {
  fetch() {
    return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': setCookie(COOKIE, '', 0), 'cache-control': 'no-store' } });
  },
};
