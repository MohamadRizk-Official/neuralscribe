// /auth/callback — where Google sign-in, email confirmation and password-reset links land.
// The Supabase client (PKCE + detectSessionInUrl) swaps the ?code= for a session on its own;
// getSession() waits for that to finish.
import { supabase, isConfigured } from '../lib/supabase.js';
import { safeNext } from '../lib/account.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const hash = new URLSearchParams(location.hash.slice(1));
const next = safeNext(params.get('next'), '/');

function fail(title, text) {
  $('spinner').classList.add('hidden');
  $('cbTitle').textContent = title;
  $('cbText').textContent = text;
  $('cbBtn').classList.remove('hidden');
}

(async () => {
  if (!isConfigured) return fail('Accounts aren\'t available', 'This copy of the site isn\'t connected to an account server.');

  const errorText = params.get('error_description') || hash.get('error_description');
  if (errorText) return fail("Couldn't sign you in", errorText.replace(/\+/g, ' '));

  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) {
    return fail(
      'This link didn\'t work',
      'It may have expired, been used already, or been opened in a different browser from the one you signed up in. Sign in again, or request a new link.',
    );
  }
  location.replace(next);
})();
