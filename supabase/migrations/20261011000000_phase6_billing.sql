-- Phase 6: plans, Stripe subscriptions, transcription usage and quota.
--
-- Principles
--   * billing_plans is the single source of truth for plan names, prices and monthly allowances. The browser
--     and the server both read it; Stripe price IDs live in server environment variables
--     (STRIPE_<PLAN>_PRICE_ID) because they differ between test and live mode.
--   * Stripe is the billing source of truth. subscriptions holds the synchronized state, written only by
--     the Stripe webhook through billing_* functions that require a server-only secret. Signed-in users can
--     read their own row and nothing else; they can never write plan, status or Stripe IDs.
--   * usage is an immutable ledger: one row per saved transcription, written by a database trigger when
--     the transcription is saved (exact seconds). Users can read their own rows only.
--   * Quota is enforced in the database when a transcription is saved (and checked by the server before a
--     transcription starts). Existing recordings are never counted: counting starts at
--     billing_settings.metering_starts_at.
--   * Everything is additive: no recording, folder, note, answer or artifact is touched.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Plans (single source of truth)
-- ---------------------------------------------------------------------------
create table public.billing_plans (
  key              text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  name             text not null,
  tagline          text not null,
  price_cents      integer not null check (price_cents >= 0),
  currency         text not null default 'usd',
  billing_interval text check (billing_interval in ('month', 'year')), -- null = no Stripe price (Free)
  monthly_seconds  integer not null check (monthly_seconds > 0),
  sort_order       integer not null,
  is_default       boolean not null default false,
  active           boolean not null default true
);
create unique index billing_plans_one_default on public.billing_plans (is_default) where is_default;

insert into public.billing_plans (key, name, tagline, price_cents, currency, billing_interval, monthly_seconds, sort_order, is_default) values
  ('free', 'Free', 'For trying SparkScribe', 0,    'usd', null,    3600,   0, true),   -- 60 minutes
  ('plus', 'Plus', 'For regular use',        799,  'usd', 'month', 72000,  1, false),  -- 20 hours
  ('pro',  'Pro',  'For heavy use',          1499, 'usd', 'month', 180000, 2, false);  -- 50 hours

alter table public.billing_plans enable row level security;
create policy "billing_plans: anyone can read" on public.billing_plans for select to anon, authenticated using (true);
revoke all on public.billing_plans from anon, authenticated;
grant select on public.billing_plans to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Billing settings (one row; server/admin only)
-- ---------------------------------------------------------------------------
create table public.billing_settings (
  id                 boolean primary key default true check (id),
  -- which Stripe mode's subscriptions grant access. Test subscriptions never count once this is true.
  stripe_livemode    boolean not null default false,
  -- usage saved before this moment is never counted (null: metering not started, nothing counts)
  metering_starts_at timestamptz,
  -- reject saves over the allowance everywhere
  enforce_quota      boolean not null default false,
  -- while enforce_quota is off, enforce only for requests from these origins (e.g. the Phase 6 Preview).
  -- Preview and Production share this database; this keeps limits off the live site until launch.
  enforce_origins    text[] not null default '{}',
  updated_at         timestamptz not null default now()
);
insert into public.billing_settings (id) values (true);
alter table public.billing_settings enable row level security;
revoke all on public.billing_settings from anon, authenticated;

-- server-only secret for the billing_* write functions (only its SHA-256 is stored)
create table private.billing_secrets (
  name text primary key,
  hash bytea not null
);

-- ---------------------------------------------------------------------------
-- subscriptions (Phase 1 table, extended; one row per user)
-- ---------------------------------------------------------------------------
drop index if exists public.subscriptions_user_id_idx;
alter table public.subscriptions
  add column stripe_price_id      text,
  add column cancel_at_period_end boolean not null default false,
  add column cancel_at            timestamptz,
  add column canceled_at          timestamptz,
  add column livemode             boolean not null default false,
  add column synced_at            timestamptz,
  add constraint subscriptions_user_id_key unique (user_id),
  add constraint subscriptions_customer_key unique (stripe_customer_id),
  add constraint subscriptions_subscription_key unique (stripe_subscription_id),
  add constraint subscriptions_plan_fkey foreign key (plan) references public.billing_plans (key),
  add constraint subscriptions_status_check check (status in
    ('inactive', 'active', 'trialing', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused'));
-- (read-own policy and select-only grant from Phase 1 stay as they are)

-- ---------------------------------------------------------------------------
-- usage (Phase 1 table, reshaped into an immutable per-transcription ledger; it was never written)
-- ---------------------------------------------------------------------------
drop trigger if exists usage_set_updated_at on public.usage;
alter table public.usage drop constraint if exists usage_user_id_billing_period_start_key;
alter table public.usage
  drop column transcription_seconds,
  drop column ai_usage,
  drop column updated_at,
  alter column billing_period_start type timestamptz using billing_period_start::timestamptz,
  alter column billing_period_end type timestamptz using billing_period_end::timestamptz,
  add column transcription_id uuid not null,      -- no foreign key: deleting a recording keeps its usage
  add column seconds numeric(12, 3) not null check (seconds >= 0),
  add column plan text not null,
  add column source text not null default 'transcription' check (source in ('transcription', 'test'));
create unique index usage_transcription_id_key on public.usage (transcription_id);
create index usage_user_created_idx on public.usage (user_id, created_at);

create or replace function private.usage_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'usage rows cannot be changed';
end;
$$;
create trigger usage_no_update before update on public.usage
  for each row execute function private.usage_immutable();

-- ---------------------------------------------------------------------------
-- billing_events: processed Stripe events (idempotency) + audit log. Server/admin only.
-- ---------------------------------------------------------------------------
create table public.billing_events (
  id                     text primary key,           -- Stripe event id
  type                   text not null,
  livemode               boolean not null,
  user_id                uuid,
  stripe_customer_id     text,
  stripe_subscription_id text,
  result                 text not null default 'processing',
  detail                 text,
  created_at             timestamptz not null default now(),
  processed_at           timestamptz
);
alter table public.billing_events enable row level security;
revoke all on public.billing_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Entitlements: the one place that decides a user's plan, period and remaining time
-- ---------------------------------------------------------------------------
-- Statuses that keep paid access: active, trialing, and past_due (Stripe is still retrying the payment).
-- unpaid, canceled, incomplete, incomplete_expired, paused -> Free.
create or replace function private.entitlement(p_user uuid, p_at timestamptz default now())
returns table (
  plan text, plan_name text, status text, monthly_seconds integer, used_seconds numeric,
  period_start timestamptz, period_end timestamptz, period_kind text,
  cancel_at_period_end boolean, has_billing_account boolean, payment_problem boolean, livemode boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare
  bs public.billing_settings;
  s public.subscriptions;
  p public.billing_plans;
  paid boolean := false;
  starts timestamptz;
begin
  select * into bs from public.billing_settings where id;
  select * into s from public.subscriptions where user_id = p_user;
  if s.user_id is not null and s.livemode = bs.stripe_livemode
     and s.status in ('active', 'trialing', 'past_due') and s.plan <> 'free'
     and s.current_period_start is not null and s.current_period_end is not null
     and s.current_period_end > p_at - interval '2 days' then   -- small grace if a renewal webhook is late
    select * into p from public.billing_plans where key = s.plan;
    paid := p.key is not null;
  end if;

  if paid then
    plan := p.key; plan_name := p.name; monthly_seconds := p.monthly_seconds;
    status := s.status; period_start := s.current_period_start; period_end := s.current_period_end; period_kind := 'billing';
    -- a period that ended without a renewal webhook yet: keep counting from its start
    if period_end <= p_at then period_end := p_at + interval '1 second'; end if;
  else
    select * into p from public.billing_plans where is_default;
    plan := p.key; plan_name := p.name; monthly_seconds := p.monthly_seconds;
    status := 'free';
    period_start := date_trunc('month', p_at at time zone 'utc') at time zone 'utc';  -- calendar month, UTC
    period_end := (date_trunc('month', p_at at time zone 'utc') + interval '1 month') at time zone 'utc';
    period_kind := 'calendar_month';
  end if;

  cancel_at_period_end := paid and coalesce(s.cancel_at_period_end, false);
  has_billing_account := coalesce(s.stripe_customer_id is not null and s.livemode = bs.stripe_livemode, false);
  payment_problem := coalesce(s.livemode = bs.stripe_livemode and s.status in ('past_due', 'unpaid', 'incomplete'), false);
  livemode := bs.stripe_livemode;

  starts := greatest(period_start, bs.metering_starts_at);
  if bs.metering_starts_at is null then
    used_seconds := 0;
  else
    select coalesce(sum(u.seconds), 0) into used_seconds from public.usage u
     where u.user_id = p_user and u.created_at >= starts and u.created_at < period_end;
  end if;
  return next;
end;
$$;

-- Is the quota enforced for this request? (everywhere once launched; before that only for listed origins)
create or replace function private.quota_enforced() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  bs public.billing_settings;
  origin text;
begin
  select * into bs from public.billing_settings where id;
  if bs.enforce_quota then return true; end if;
  begin
    origin := coalesce(current_setting('request.headers', true)::json ->> 'origin', '');
  exception when others then origin := '';
  end;
  return origin <> '' and origin = any (bs.enforce_origins);
end;
$$;

-- What the signed-in user sees on the Account page / usage meter. Never takes a user id from the caller.
create or replace function public.billing_status()
returns json language plpgsql stable security definer set search_path = '' as $$
declare
  e record;
  s public.subscriptions;
  bs public.billing_settings;
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into e from private.entitlement(uid);
  select * into s from public.subscriptions where user_id = uid;
  select * into bs from public.billing_settings where id;
  return json_build_object(
    'plan', e.plan, 'planName', e.plan_name, 'status', e.status,
    'monthlySeconds', e.monthly_seconds, 'usedSeconds', e.used_seconds,
    'remainingSeconds', greatest(e.monthly_seconds - e.used_seconds, 0),
    'periodStart', e.period_start, 'periodEnd', e.period_end, 'periodKind', e.period_kind,
    'cancelAtPeriodEnd', e.cancel_at_period_end, 'hasBillingAccount', e.has_billing_account,
    'paymentProblem', e.payment_problem,
    'subscriptionStatus', case when s.livemode = bs.stripe_livemode then s.status end,
    'meteringStarted', bs.metering_starts_at is not null,
    'enforced', private.quota_enforced(),
    'enforceQuota', bs.enforce_quota, 'enforceOrigins', bs.enforce_origins
  );
end;
$$;
revoke all on function public.billing_status() from public, anon;
grant execute on function public.billing_status() to authenticated;

-- ---------------------------------------------------------------------------
-- Usage is recorded (and the quota checked) when a transcription is saved
-- ---------------------------------------------------------------------------
-- Billable time = the longest of: the reported duration, the last line's end time, and a floor from the
-- word count (nobody speaks faster than ~4 words a second). Transcription runs on the user's device, so
-- these are client-reported values; the cross-checks only make under-reporting harder.
create or replace function private.billable_seconds(p_duration integer, p_segments jsonb, p_text text)
returns numeric language plpgsql immutable set search_path = '' as $$
declare
  max_end numeric := 0;
  words integer := 0;
begin
  if jsonb_typeof(p_segments) = 'array' then
    -- only well-formed numbers count; a malformed value must never make a save fail
    select coalesce(max(case when x ->> 'e' ~ '^[0-9]{1,9}(\.[0-9]+)?$' then (x ->> 'e')::numeric end), 0),
           coalesce(sum(case when btrim(coalesce(x ->> 't', '')) = '' then 0
                             else array_length(regexp_split_to_array(btrim(x ->> 't'), '\s+'), 1) end), 0)
      into max_end, words
      from jsonb_array_elements(p_segments) x;
  elsif btrim(coalesce(p_text, '')) <> '' then
    words := array_length(regexp_split_to_array(btrim(p_text), '\s+'), 1);
  end if;
  return least(greatest(coalesce(p_duration, 0)::numeric, max_end, words / 4.0), 360000);  -- cap: 100 hours
end;
$$;

create or replace function private.on_transcription_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  e record;
  secs numeric;
begin
  secs := private.billable_seconds(new.duration_seconds, new.segments, new.transcript_text);
  perform pg_advisory_xact_lock(hashtextextended('sparkscribe:usage:' || new.user_id::text, 0));
  select * into e from private.entitlement(new.user_id);
  if private.quota_enforced() and e.used_seconds + secs > e.monthly_seconds + 1 then
    raise exception 'quota_exceeded'
      using errcode = 'P0001',
            detail = json_build_object('plan', e.plan, 'remainingSeconds', greatest(e.monthly_seconds - e.used_seconds, 0), 'requestedSeconds', secs)::text,
            hint = 'This transcription is longer than the time left on your plan this month.';
  end if;
  insert into public.usage (user_id, transcription_id, seconds, plan, billing_period_start, billing_period_end)
  values (new.user_id, new.id, secs, e.plan, e.period_start, e.period_end)
  on conflict (transcription_id) do nothing;
  return new;
end;
$$;
create trigger transcriptions_record_usage before insert on public.transcriptions
  for each row execute function private.on_transcription_insert();

-- A saved recording can't be made longer afterwards (that would be usage that was never counted).
create or replace function private.on_transcription_duration_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  billed numeric;
begin
  select seconds into billed from public.usage where transcription_id = new.id;
  if billed is not null
     and private.billable_seconds(new.duration_seconds, new.segments, null) > greatest(billed, private.billable_seconds(old.duration_seconds, old.segments, null)) + 1 then
    raise exception 'recording_length_locked' using errcode = 'P0001', hint = 'The length of a saved recording cannot be increased.';
  end if;
  return new;
end;
$$;
create trigger transcriptions_lock_duration before update of duration_seconds, segments on public.transcriptions
  for each row execute function private.on_transcription_duration_update();

-- ---------------------------------------------------------------------------
-- Server-only write functions for the Stripe integration. Callable over the API, but only with the
-- server's secret (BILLING_DB_SECRET); everything else about the user comes from Stripe, never the browser.
-- ---------------------------------------------------------------------------
create or replace function private.check_billing_secret(p_secret text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  h bytea;
begin
  select hash into h from private.billing_secrets where name = 'server';
  if h is null or p_secret is null or extensions.digest(p_secret, 'sha256') <> h then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

-- Start processing a Stripe event once. Returns 'new', or 'duplicate' if it was already handled
-- (an event stuck in 'processing' for over 5 minutes may be retried).
create or replace function public.billing_event_begin(p_secret text, p_event_id text, p_type text, p_livemode boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  ev public.billing_events;
begin
  perform private.check_billing_secret(p_secret);
  insert into public.billing_events (id, type, livemode) values (p_event_id, p_type, p_livemode)
  on conflict (id) do nothing;
  if found then return 'new'; end if;
  select * into ev from public.billing_events where id = p_event_id for update;
  if ev.result in ('processing', 'error') and ev.created_at < now() - interval '5 minutes' then
    update public.billing_events set result = 'processing', created_at = now() where id = p_event_id;
    return 'new';
  end if;
  if ev.result = 'error' then
    update public.billing_events set result = 'processing' where id = p_event_id;
    return 'new';
  end if;
  return 'duplicate';
end;
$$;

create or replace function public.billing_event_finish(p_secret text, p_event_id text, p_result text, p_detail text,
  p_user uuid, p_customer text, p_subscription text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_billing_secret(p_secret);
  update public.billing_events
     set result = left(p_result, 40), detail = left(p_detail, 300), user_id = p_user,
         stripe_customer_id = p_customer, stripe_subscription_id = p_subscription, processed_at = now()
   where id = p_event_id;
end;
$$;

-- One Stripe customer per account. Returns the customer already linked to the user (in this mode) if
-- there is one, otherwise links p_customer. Refuses a customer that belongs to someone else.
create or replace function public.billing_link_customer(p_secret text, p_user uuid, p_customer text, p_livemode boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  s public.subscriptions;
begin
  perform private.check_billing_secret(p_secret);
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'unknown_user'; end if;
  if exists (select 1 from public.subscriptions where stripe_customer_id = p_customer and user_id <> p_user) then
    raise exception 'customer_belongs_to_another_user';
  end if;
  insert into public.subscriptions (user_id) values (p_user) on conflict (user_id) do nothing;
  select * into s from public.subscriptions where user_id = p_user for update;
  if s.stripe_customer_id is not null and s.livemode = p_livemode then
    return s.stripe_customer_id;
  end if;
  update public.subscriptions
     set stripe_customer_id = p_customer, livemode = p_livemode,
         -- a customer from the other mode: forget its subscription too
         stripe_subscription_id = case when s.livemode = p_livemode then s.stripe_subscription_id end,
         plan = case when s.livemode = p_livemode then s.plan else 'free' end,
         status = case when s.livemode = p_livemode then s.status else 'inactive' end
   where user_id = p_user;
  return p_customer;
end;
$$;

-- Store a subscription's state as Stripe reports it. The user is the one already linked to the customer;
-- a subscription whose metadata names a different user, or an unknown customer, is refused.
create or replace function public.billing_apply_subscription(p_secret text, p_customer text, p_meta_user uuid,
  p_subscription text, p_status text, p_plan text, p_price text, p_livemode boolean,
  p_period_start timestamptz, p_period_end timestamptz, p_cancel_at_period_end boolean,
  p_cancel_at timestamptz, p_canceled_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  s public.subscriptions;
begin
  perform private.check_billing_secret(p_secret);
  select * into s from public.subscriptions where stripe_customer_id = p_customer for update;
  if s.user_id is null then raise exception 'unknown_customer'; end if;
  if p_meta_user is not null and p_meta_user <> s.user_id then raise exception 'user_mismatch'; end if;
  if s.livemode <> p_livemode then raise exception 'mode_mismatch'; end if;
  -- Another subscription of the same customer: only replace the stored one if it no longer gives access
  -- or this one does (e.g. a stale "canceled" event must not overwrite a newer active subscription).
  if s.stripe_subscription_id is not null and s.stripe_subscription_id <> p_subscription
     and s.status in ('active', 'trialing', 'past_due')
     and p_status not in ('active', 'trialing', 'past_due') then
    return s.user_id;
  end if;
  if p_plan is null or not exists (select 1 from public.billing_plans where key = p_plan and billing_interval is not null) then
    p_plan := 'free';   -- unknown price: stored, but grants nothing
  end if;
  update public.subscriptions
     set stripe_subscription_id = p_subscription, status = p_status, plan = p_plan, stripe_price_id = p_price,
         current_period_start = p_period_start, current_period_end = p_period_end,
         cancel_at_period_end = coalesce(p_cancel_at_period_end, false), cancel_at = p_cancel_at,
         canceled_at = p_canceled_at, synced_at = now()
   where user_id = s.user_id;
  return s.user_id;
end;
$$;

revoke all on function public.billing_event_begin(text, text, text, boolean) from public;
revoke all on function public.billing_event_finish(text, text, text, text, uuid, text, text) from public;
revoke all on function public.billing_link_customer(text, uuid, text, boolean) from public;
revoke all on function public.billing_apply_subscription(text, text, uuid, text, text, text, text, boolean, timestamptz, timestamptz, boolean, timestamptz, timestamptz) from public;
-- The webhook has no user session, so these run as anon; the secret check inside is the gate.
grant execute on function public.billing_event_begin(text, text, text, boolean) to anon, authenticated;
grant execute on function public.billing_event_finish(text, text, text, text, uuid, text, text) to anon, authenticated;
grant execute on function public.billing_link_customer(text, uuid, text, boolean) to anon, authenticated;
grant execute on function public.billing_apply_subscription(text, text, uuid, text, text, text, text, boolean, timestamptz, timestamptz, boolean, timestamptz, timestamptz) to anon, authenticated;

revoke all on all functions in schema private from public, anon, authenticated;
