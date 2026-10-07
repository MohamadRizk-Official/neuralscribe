// /auth — sign in, create account, forgot password, and set a new password (after a reset link).
import { supabase, isConfigured, authSettings } from '../lib/supabase.js';
import { mountAccountMenu, safeNext, getUser } from '../lib/account.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const next = safeNext(params.get('next'), '/');
const callbackUrl = (to) => `${location.origin}/auth/callback?next=${encodeURIComponent(to)}`;

const MODES = {
  signin: { title: 'Welcome back', sub: 'Sign in to save transcripts to your library and open them on any device.', submit: 'Sign in' },
  signup: { title: 'Create your account', sub: 'Free. Save transcripts and come back to them any time.', submit: 'Create account' },
  forgot: { title: 'Reset your password', sub: "Enter your email and we'll send you a link to choose a new password.", submit: 'Send reset link' },
  update: { title: 'Choose a new password', sub: 'Pick a new password for your account.', submit: 'Save new password' },
};
let mode = 'signin';

if (!isConfigured) {
  document.querySelector('.auth-card').classList.add('hidden');
  $('notConfigured').classList.remove('hidden');
} else {
  init();
}

async function init() {
  const requested = params.get('mode');
  const session = await getUser(); // server-verified; clears a stale local session
  mountAccountMenu($('accountSlot'));
  if (requested === 'update') {
    if (!session) {
      setMode('forgot');
      showMsg('That reset link has expired or was already used. Request a new one below.', 'error');
    } else setMode('update');
  } else if (session) {
    location.replace(next); // already signed in
    return;
  } else {
    setMode(requested === 'signup' ? 'signup' : 'signin');
  }

  authSettings().then((s) => {
    if (s && !s.external?.google) {
      $('googleBtn').disabled = true;
      $('googleOff').classList.remove('hidden');
    }
  });

  document.querySelectorAll('#authTabs button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('forgotLink').addEventListener('click', (e) => { e.preventDefault(); setMode('forgot'); });
  $('backToSignin').addEventListener('click', (e) => { e.preventDefault(); setMode('signin'); });
  $('googleBtn').addEventListener('click', google);
  $('authForm').addEventListener('submit', submit);
}

function setMode(m) {
  mode = m;
  const cfg = MODES[m];
  $('authTitle').textContent = cfg.title;
  $('authSub').textContent = cfg.sub;
  $('submitBtn').textContent = cfg.submit;
  document.querySelectorAll('#authTabs button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('authTabs').classList.toggle('hidden', m === 'forgot' || m === 'update');
  const social = m === 'signin' || m === 'signup';
  $('googleBtn').classList.toggle('hidden', !social);
  document.querySelector('.auth-or').classList.toggle('hidden', !social);
  if (!social) $('googleOff').classList.add('hidden');
  else authSettings().then((s) => $('googleOff').classList.toggle('hidden', !(s && !s.external?.google)));
  $('emailField').classList.toggle('hidden', m === 'update');
  $('passwordField').classList.toggle('hidden', m === 'forgot');
  $('forgotLink').classList.toggle('hidden', m !== 'signin');
  $('confirmField').classList.toggle('hidden', !(m === 'signup' || m === 'update'));
  $('password').autocomplete = m === 'signin' ? 'current-password' : 'new-password';
  $('backToSignin').classList.toggle('hidden', m !== 'forgot');
  hideMsg();
}

function showMsg(text, kind = 'info') {
  const el = $('authMsg');
  el.textContent = text;
  el.className = `auth-msg ${kind}`;
}
function hideMsg() { $('authMsg').className = 'auth-msg hidden'; }

function busy(on) {
  $('submitBtn').disabled = on;
  $('submitBtn').classList.toggle('loading', on);
}

// Supabase error messages, made friendlier where it matters.
function explain(error) {
  const msg = error?.message || String(error);
  if (/invalid login credentials/i.test(msg)) return 'Wrong email or password.';
  if (/email not confirmed/i.test(msg)) return 'Please confirm your email first. Check your inbox for the link we sent.';
  if (/already registered|already exists/i.test(msg)) return 'An account with this email already exists. Try signing in.';
  if (/rate limit|too many/i.test(msg)) return 'Too many attempts. Please wait a minute and try again.';
  if (/redirect/i.test(msg)) return `${msg} (The site address may not be allowed in the Supabase auth settings yet.)`;
  return msg;
}

async function submit(e) {
  e.preventDefault();
  hideMsg();
  const email = $('email').value.trim();
  const password = $('password').value;
  const confirm = $('confirm').value;

  if (mode !== 'update' && !/^\S+@\S+\.\S+$/.test(email)) return showMsg('Enter a valid email address.', 'error');
  if ((mode === 'signin' || mode === 'signup' || mode === 'update') && password.length < 8) return showMsg('Passwords need at least 8 characters.', 'error');
  if ((mode === 'signup' || mode === 'update') && password !== confirm) return showMsg("The two passwords don't match.", 'error');

  busy(true);
  try {
    if (mode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      location.replace(next);
    } else if (mode === 'signup') {
      const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: callbackUrl(next) } });
      if (error) throw error;
      if (data.session) return location.replace(next); // email confirmation is off
      // With confirmation on, Supabase deliberately gives the same answer for new and existing emails.
      showMsg(`Check ${email} for a confirmation link. Open it in this browser to finish creating your account.`, 'success');
      $('authForm').reset();
    } else if (mode === 'forgot') {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: callbackUrl('/auth?mode=update') });
      if (error) throw error;
      showMsg(`If an account exists for ${email}, a reset link is on its way. Open it in this browser.`, 'success');
    } else if (mode === 'update') {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      showMsg('Password updated. Taking you to your library…', 'success');
      setTimeout(() => location.replace('/library'), 900);
    }
  } catch (err) {
    showMsg(explain(err), 'error');
  } finally {
    busy(false);
  }
}

async function google() {
  hideMsg();
  const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: callbackUrl(next) } });
  if (error) showMsg(explain(error), 'error');
}
