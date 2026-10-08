# Phase 6 billing: what remains (paused 2026-10-08)

Stripe setup is paused until the business/LLC and Stripe account are ready. Everything below is on branch
`phase-6-billing`; nothing is merged to Production and no billing is active anywhere.

## Current state

- Database (shared by Preview and Production): Phase 6 schema applied (`billing_plans`, `billing_settings`,
  extended `subscriptions`, `usage` ledger, `billing_events`, entitlement functions, save-time usage trigger).
  `billing_settings`: `metering_starts_at = null` (nothing is counted), `enforce_quota = false`,
  `enforce_origins = {}` (no limits anywhere), `stripe_livemode = false`. No subscriptions, usage or events.
- Vercel: only `BILLING_DB_SECRET` exists (Preview, branch `phase-6-billing`). No Stripe variables anywhere.
  If that secret is ever lost, generate a new random value, store its SHA-256 in `private.billing_secrets`
  (`name = 'server'`) and set the new value in Vercel.

## When the Stripe account is ready

### 1. Test mode (Preview)
1. Stripe Dashboard, **Test mode** on: Developers → API keys → copy the `sk_test_…` secret key.
   Put it in `.env.local` as `STRIPE_SECRET_KEY=…` (never in chat or code).
2. Branding: Settings → Business → Public details: name **SparkScribe**; Settings → Branding: icon/colours.
3. Claude runs `node scripts/stripe-setup.mjs --webhook-url https://sparkscribe-git-phase-6-billing-moerizz.vercel.app/api/stripe-webhook --secret-out <file>`,
   which creates SparkScribe Plus ($7.99/mo) and Pro ($14.99/mo), the Customer Portal configuration and the
   webhook, then sets in Vercel **Preview (branch phase-6-billing) only**:
   `STRIPE_SECRET_KEY` (test), `STRIPE_WEBHOOK_SECRET`, `STRIPE_PLUS_PRICE_ID`, `STRIPE_PRO_PRICE_ID`,
   `STRIPE_PORTAL_CONFIGURATION_ID`.
4. Turn on counting/limits for the Preview only:
   `update billing_settings set metering_starts_at = now(), enforce_origins = '{https://sparkscribe-git-phase-6-billing-moerizz.vercel.app}'`.
5. Tests: Free → Plus and Free → Pro through Checkout (test card 4242 4242 4242 4242, entered by you);
   Plus → Pro (prorated, via the portal); cancel at period end; failed payment (test clock + failing card);
   Customer Portal opens the right customer; duplicate / invalid / replayed / wrong-user / unknown-customer /
   unknown-price webhooks change nothing; quota: near limit, at limit, over limit, longer-than-remaining
   recording, duplicate save, failed transcription, historical recordings, period reset.

### 2. Live mode (Production), only after every test passes
1. Stripe: activate the account (business details, bank account, identity verification), then in **live**
   mode re-run the setup script with the `sk_live_…` key and the production webhook URL
   `https://sparkscribe-moerizz.vercel.app/api/stripe-webhook`.
2. Vercel **Production** only: `STRIPE_SECRET_KEY` (live), `STRIPE_WEBHOOK_SECRET` (live endpoint),
   live `STRIPE_PLUS_PRICE_ID`, `STRIPE_PRO_PRICE_ID`, `STRIPE_PORTAL_CONFIGURATION_ID`, and
   `BILLING_DB_SECRET`. Preview must keep test keys only.
3. Customer Portal (live): terms of service and privacy policy URLs (final legal pages needed).
4. Tax: decide whether to enable Stripe Tax (not built into SparkScribe).
5. Merge `phase-6-billing` to `main`, then in the database:
   `update billing_settings set stripe_livemode = true, metering_starts_at = now(), enforce_quota = true, enforce_origins = '{}'`.
   (`metering_starts_at = now()` means nothing before launch is counted.)

### Launch requirements outside Stripe
- Final Terms of Service and Privacy Policy pages (not drafted by SparkScribe/AI as legal advice).
- Account deletion: there is no in-app account deletion yet. Deleting a user in the Supabase dashboard would
  not cancel their Stripe subscription; cancel it in Stripe first, or build deletion that cancels billing.
- Supabase: enable leaked-password protection (Authentication settings).
