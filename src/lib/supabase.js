// One shared Supabase client for every page.
// The URL and the sb_publishable_ key are public by design; all data protection is enforced in the
// database by Row Level Security (see supabase/migrations). Never put a secret key in the browser.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.NEXT_PUBLIC_SUPABASE_URL;
const key = import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Without these, the transcription tool keeps working exactly as before; account features hide.
export const isConfigured = Boolean(url && key);

export const supabase = isConfigured
  ? createClient(url, key, {
      auth: {
        flowType: 'pkce', // auth codes in redirects, exchanged with a verifier kept in this browser
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export const supabaseUrl = url || '';

// Which sign-in methods are switched on in the Supabase dashboard (public endpoint).
let settingsPromise;
export function authSettings() {
  if (!isConfigured) return Promise.resolve(null);
  settingsPromise ??= fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return settingsPromise;
}
