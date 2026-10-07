-- Phase 1: accounts + saved transcripts.
--
-- Security model
--   * Every table has RLS enabled; policies only ever match rows where user_id / id = auth.uid().
--   * The browser never chooses user_id: it defaults to auth.uid() and is not in the INSERT grant.
--   * usage and subscriptions are read-only for signed-in users. Writes are reserved for trusted
--     server-side code (service role), which bypasses RLS — e.g. future Stripe webhooks.
--   * anon (signed-out visitors) has no access to any of these tables.

-- ---------------------------------------------------------------------------
-- Shared helper: keep updated_at current
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- transcriptions
-- ---------------------------------------------------------------------------
create table public.transcriptions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title              text not null default 'Untitled transcript' check (char_length(title) between 1 and 300),
  status             text not null default 'completed' check (status in ('queued', 'processing', 'completed', 'failed')),
  duration_seconds   integer check (duration_seconds is null or duration_seconds >= 0),
  language           text,
  recording_type     text,
  transcript_text    text not null default '',
  original_file_path text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Serves both "all of my transcripts" and "newest first"; a separate (user_id) index would be redundant.
create index transcriptions_user_id_created_at_idx on public.transcriptions (user_id, created_at desc);

create trigger transcriptions_set_updated_at
  before update on public.transcriptions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- usage (prepared for later; written only by trusted server code)
-- ---------------------------------------------------------------------------
create table public.usage (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users (id) on delete cascade,
  billing_period_start  date not null,
  billing_period_end    date not null,
  transcription_seconds bigint not null default 0,
  ai_usage              bigint not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- one row per user per period; also serves as the user_id index
  unique (user_id, billing_period_start)
);

create trigger usage_set_updated_at
  before update on public.usage
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- subscriptions (prepared for Stripe later; written only by trusted server code)
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users (id) on delete cascade,
  plan                   text not null default 'free',
  status                 text not null default 'inactive',
  stripe_customer_id     text,
  stripe_subscription_id text,
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index subscriptions_user_id_idx on public.subscriptions (user_id);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Profile creation: done in the database when the auth user is created, so it
-- cannot be skipped by a closed browser tab.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- These are trigger-only functions; nobody should be able to call them directly.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Privileges (defence in depth on top of RLS)
-- ---------------------------------------------------------------------------
revoke all on public.profiles, public.transcriptions, public.usage, public.subscriptions from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;

grant select, delete on public.transcriptions to authenticated;
-- user_id is deliberately absent: it always comes from auth.uid()
grant insert (title, status, duration_seconds, language, recording_type, transcript_text)
  on public.transcriptions to authenticated;
grant update (title, status, duration_seconds, language, recording_type, transcript_text)
  on public.transcriptions to authenticated;

grant select on public.usage to authenticated;
grant select on public.subscriptions to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.transcriptions enable row level security;
alter table public.usage         enable row level security;
alter table public.subscriptions enable row level security;

-- profiles
create policy "profiles: read own"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id);

create policy "profiles: update own"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- transcriptions
create policy "transcriptions: read own"
  on public.transcriptions for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "transcriptions: insert own"
  on public.transcriptions for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "transcriptions: update own"
  on public.transcriptions for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "transcriptions: delete own"
  on public.transcriptions for delete to authenticated
  using ((select auth.uid()) = user_id);

-- usage / subscriptions: read only
create policy "usage: read own"
  on public.usage for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "subscriptions: read own"
  on public.subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);
