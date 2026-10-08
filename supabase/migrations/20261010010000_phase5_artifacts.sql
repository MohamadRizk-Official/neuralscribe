-- Phase 5: study tools and productivity outputs (Study Guide, Flashcards, Quiz, Meeting Recap, drafts…).
--
-- Design: ONE table for every generated output ("artifact"), shaped like transcription_insights.
--   * kind + settings_key identify a result: the same recording, kind and settings (e.g. "fewer" flashcards)
--     is generated once and then read from here; different settings are separate rows.
--   * source_version records the transcript version it was made from; when transcriptions.content_version
--     moves on, the output shows as out of date until the user asks to update it.
--   * status generating / ready / failed, with a unique key, so concurrent requests share one generation.
--     A failed regeneration keeps the previous content.
--   * progress: small user-owned state (e.g. the latest quiz score). It is the only column a user changes
--     that the AI never writes.
-- Generated outputs are not part of Library search (the transcript stays the source of truth).
--
-- Security: same model as transcription_insights. RLS on every operation; a row is visible/writable only when
-- user_id = auth.uid() and the parent recording belongs to that same user; user_id is never writable.
-- Deleting a recording deletes its artifacts (on delete cascade); deleting an artifact never touches the
-- recording.

create table public.transcription_artifacts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  transcription_id uuid not null references public.transcriptions (id) on delete cascade,
  kind             text not null check (kind in (
                     'study_guide', 'flashcards', 'quiz', 'definitions', 'exam_points',
                     'meeting_recap', 'action_plan', 'followup_email', 'reply_draft',
                     'interview_qa', 'episode_notes')),
  settings         jsonb not null default '{}' check (jsonb_typeof(settings) = 'object'),
  settings_key     text not null default '' check (char_length(settings_key) <= 100),
  status           text not null default 'generating' check (status in ('generating', 'ready', 'failed')),
  content          jsonb,
  error            text check (error is null or char_length(error) <= 500),
  source_version   integer not null,
  model            text,
  input_tokens     integer,
  output_tokens    integer,
  progress         jsonb check (progress is null or (jsonb_typeof(progress) = 'object' and pg_column_size(progress) <= 4000)),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (transcription_id, kind, settings_key)
);

create index transcription_artifacts_user_id_idx on public.transcription_artifacts (user_id);

create trigger transcription_artifacts_set_updated_at
  before update on public.transcription_artifacts
  for each row execute function public.set_updated_at();

revoke all on public.transcription_artifacts from anon, authenticated;
grant select, delete on public.transcription_artifacts to authenticated;
grant insert (transcription_id, kind, settings, settings_key, status, content, error, source_version, model, input_tokens, output_tokens)
  on public.transcription_artifacts to authenticated;
grant update (status, content, error, source_version, model, input_tokens, output_tokens, progress)
  on public.transcription_artifacts to authenticated;

alter table public.transcription_artifacts enable row level security;

create policy "artifacts: read own"
  on public.transcription_artifacts for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "artifacts: insert own"
  on public.transcription_artifacts for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.transcriptions t where t.id = transcription_id and t.user_id = (select auth.uid()))
  );

create policy "artifacts: update own"
  on public.transcription_artifacts for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.transcriptions t where t.id = transcription_id and t.user_id = (select auth.uid()))
  );

create policy "artifacts: delete own"
  on public.transcription_artifacts for delete to authenticated
  using ((select auth.uid()) = user_id);
