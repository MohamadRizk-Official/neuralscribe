// Step 2: GitHub sends the visitor back here with a one-time code.
// We swap it for a token, ask GitHub what this person may do in the project's repo, and only
// let them in if they have write access (owner / collaborator / team with push). The token is
// used for those two requests and then thrown away — it is never stored.
import {
  COOKIE, STATE_COOKIE, SESSION_SECONDS,
  settings, isConfigured, getCookie, setCookie, signSession, safeNext, deniedPage, notConfiguredPage, page, esc,
} from '../../lib/auth.js';

const GH = { 'user-agent': 'neuralscribe-gate', accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };

const fail = (message) =>
  page('Sign-in failed — NeuralScribe', `<h1>Sign-in failed</h1><p>${esc(message)}</p><a class="btn" href="/api/auth/login">Try again</a>`, 400, {
    'set-cookie': setCookie(STATE_COOKIE, '', 0),
  });

export default {
  async fetch(request) {
    const s = settings();
    if (!isConfigured(s)) return notConfiguredPage();

    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (url.searchParams.get('error')) return fail('GitHub sign-in was cancelled.');

    const [savedState, savedNext] = getCookie(request, STATE_COOKIE).split('|');
    if (!code || !state || !savedState || state !== savedState) return fail('That sign-in link expired. Please try again.');

    try {
      // 1. code -> token
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': GH['user-agent'] },
        body: JSON.stringify({ client_id: s.clientId, client_secret: s.clientSecret, code, redirect_uri: `https://${s.host}/api/auth/callback` }),
      });
      const { access_token: token } = await tokenRes.json();
      if (!token) return fail('GitHub did not accept the sign-in. Please try again.');
      const auth = { ...GH, authorization: `Bearer ${token}` };

      // 2. who is this?
      const userRes = await fetch('https://api.github.com/user', { headers: auth });
      if (!userRes.ok) return fail('Could not read your GitHub profile.');
      const { login } = await userRes.json();

      // 3. what can they do in the repo? (the `permissions` block describes the signed-in user)
      const repoRes = await fetch(`https://api.github.com/repos/${s.repo}`, { headers: auth });
      const repo = repoRes.ok ? await repoRes.json() : null;
      const p = repo?.permissions || {};
      if (!(p.push || p.maintain || p.admin)) return deniedPage(login, s.repo);

      const session = await signSession(login, s.secret);
      const headers = new Headers({ location: safeNext(savedNext), 'cache-control': 'no-store' });
      headers.append('set-cookie', setCookie(COOKIE, session, SESSION_SECONDS));
      headers.append('set-cookie', setCookie(STATE_COOKIE, '', 0));
      return new Response(null, { status: 302, headers });
    } catch (err) {
      console.error('auth callback failed', err);
      return fail('Something went wrong talking to GitHub. Please try again.');
    }
  },
};
