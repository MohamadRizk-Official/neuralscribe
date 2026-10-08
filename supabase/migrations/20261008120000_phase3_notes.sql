-- Phase 3: Notes as its own stored analysis kind (organized reference / study notes, separate from the
-- summary). Same table, same RLS policies and grants; only the allowed kinds change.
alter table public.transcription_insights drop constraint if exists transcription_insights_kind_check;
alter table public.transcription_insights
  add constraint transcription_insights_kind_check check (kind in ('overview', 'detailed_summary', 'notes', 'insights'));
