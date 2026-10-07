-- Phase 3: transcript intelligence (summaries, insights, Ask).
--
-- Design
--   * transcriptions.segments    line-level transcript ([{s, e, sp, t}] = start s, end s, speaker name, text),
--                                 so summaries and answers can point at real timestamps. transcript_text stays
--                                 the readable copy; older rows without segments fall back to paragraphs.
--   * transcriptions.content_version
--                                 bumped by a trigger whenever transcript_text or segments change. Every AI
--                                 result records the version it was generated from, so outdated results are
--                                 detected instead of shown as current. The browser cannot write it.
--   * transcription_insights     one cached result per (transcription, kind, recording type): a single model
--                                 call produces several sections at once (e.g. summary + key points + chapters),
--                                 so caching per call result avoids paying for the same transcript twice.
--   * transcription_questions    Ask answers, kept so reopening a recording shows them without new requests.
--
-- Security: RLS on both new tables. A row is visible/writable only when user_id = auth.uid() AND the
-- parent transcription belongs to that same user. user_id is never granted to the browser; it defaults to
-- auth.uid(). The AI server functions act with the signed-in user's own token, so they are bound by the
-- same policies (no service-role key is used).

-- ---------------------------------------------------------------------------
-- transcriptions: line-level segments + content version
-- ---------------------------------------------------------------------------
alter table public.transcriptions
  add column segments jsonb check (segments is null or jsonb_typeof(segments) = 'array'),
  add column content_version integer not null default 1;

grant insert (segments) on public.transcriptions to authenticated;
grant update (segments) on public.transcriptions to authenticated;

create or replace function public.bump_content_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.transcript_text is distinct from old.transcript_text or new.segments is distinct from old.segments then
    new.content_version := old.content_version + 1;
  else
    new.content_version := old.content_version;
  end if;
  return new;
end;
$$;

create trigger transcriptions_bump_content_version
  before update on public.transcriptions
  for each row execute function public.bump_content_version();

revoke execute on function public.bump_content_version() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- transcription_insights
-- ---------------------------------------------------------------------------
create table public.transcription_insights (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  transcription_id uuid not null references public.transcriptions (id) on delete cascade,
  kind             text not null check (kind in ('overview', 'detailed_summary', 'insights')),
  recording_type   text not null default 'general'
                   check (recording_type in ('general', 'lecture', 'meeting', 'interview', 'podcast', 'voice_message')),
  status           text not null default 'generating' check (status in ('generating', 'ready', 'failed')),
  content          jsonb,
  error            text check (error is null or char_length(error) <= 500),
  source_version   integer not null,
  model            text,
  input_tokens     integer,
  output_tokens    integer,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (transcription_id, kind, recording_type)
);

create index transcription_insights_user_id_idx on public.transcription_insights (user_id);

create trigger transcription_insights_set_updated_at
  before update on public.transcription_insights
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- transcription_questions
-- ---------------------------------------------------------------------------
create table public.transcription_questions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  transcription_id uuid not null references public.transcriptions (id) on delete cascade,
  question         text not null check (char_length(question) between 1 and 1000),
  answer           text not null default '',
  refs             jsonb not null default '[]' check (jsonb_typeof(refs) = 'array'),
  found            boolean not null default true,
  source_version   integer not null,
  model            text,
  input_tokens     integer,
  output_tokens    integer,
  created_at       timestamptz not null default now()
);

create index transcription_questions_transcription_idx on public.transcription_questions (transcription_id, created_at);
create index transcription_questions_user_id_idx on public.transcription_questions (user_id);

-- ---------------------------------------------------------------------------
-- Privileges (defence in depth on top of RLS)
-- ---------------------------------------------------------------------------
revoke all on public.transcription_insights, public.transcription_questions from anon, authenticated;

grant select, delete on public.transcription_insights to authenticated;
grant insert (transcription_id, kind, recording_type, status, content, error, source_version, model, input_tokens, output_tokens)
  on public.transcription_insights to authenticated;
grant update (status, content, error, source_version, model, input_tokens, output_tokens)
  on public.transcription_insights to authenticated;

grant select, delete on public.transcription_questions to authenticated;
grant insert (transcription_id, question, answer, refs, found, source_version, model, input_tokens, output_tokens)
  on public.transcription_questions to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.transcription_insights  enable row level security;
alter table public.transcription_questions enable row level security;

-- insights
create policy "insights: read own"
  on public.transcription_insights for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "insights: insert own"
  on public.transcription_insights for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.transcriptions t where t.id = transcription_id and t.user_id = (select auth.uid()))
  );

create policy "insights: update own"
  on public.transcription_insights for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.transcriptions t where t.id = transcription_id and t.user_id = (select auth.uid()))
  );

create policy "insights: delete own"
  on public.transcription_insights for delete to authenticated
  using ((select auth.uid()) = user_id);

-- questions
create policy "questions: read own"
  on public.transcription_questions for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "questions: insert own"
  on public.transcription_questions for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.transcriptions t where t.id = transcription_id and t.user_id = (select auth.uid()))
  );

create policy "questions: delete own"
  on public.transcription_questions for delete to authenticated
  using ((select auth.uid()) = user_id);
