-- Phase 4 cleanup: out-of-date Notes no longer take part in Library search.
-- Notes generated from an older transcript version (transcription_insights.source_version below
-- transcriptions.content_version) stay stored and keep their Phase 3 "out of date" banner on the recording,
-- but they neither make a recording match nor appear as a Notes hit until they are regenerated.
-- Same signature and grants as before.

create or replace function public.search_library(p_query text, p_limit integer default 10, p_offset integer default 0)
returns table (
  transcription_id uuid, title text, recording_type text, created_at timestamptz, duration_seconds integer,
  is_favorite boolean, title_match boolean, coarse boolean, score real, match_count integer, hits jsonb, partial boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
with params as (
  select (select auth.uid()) as uid,
         websearch_to_tsquery('english'::regconfig, left(btrim(coalesce(p_query, '')), 200)) as q,
         -- the same words, any of them: context for recordings where no single line has all of them
         nullif(replace(websearch_to_tsquery('english'::regconfig, left(btrim(coalesce(p_query, '')), 200))::text, ' & ', ' | '), '')::tsquery as q_any,
         '%' || replace(replace(replace(left(btrim(coalesce(p_query, '')), 200), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat,
         char_length(btrim(coalesce(p_query, ''))) >= 2 as ok
),
by_content as (
  select t.id from public.transcriptions t, params p
  where p.ok and numnode(p.q) > 0 and t.user_id = p.uid and t.search_tsv @@ p.q
),
by_title as (
  select t.id from public.transcriptions t, params p
  where p.ok and t.user_id = p.uid and t.title ilike p.pat
),
by_notes as (
  -- only Notes generated from the transcript's current version; out-of-date Notes stay stored (and are
  -- shown as out of date on the recording) but are not search knowledge
  select i.transcription_id as id, max(ts_rank_cd(i.search_tsv, p.q)) as r
  from public.transcription_insights i
  join public.transcriptions t on t.id = i.transcription_id and i.source_version = t.content_version
  cross join params p
  where p.ok and numnode(p.q) > 0 and i.user_id = p.uid and i.kind = 'notes' and i.search_tsv @@ p.q
  group by i.transcription_id
),
cand as (
  select t.id, t.title, t.recording_type, t.created_at, t.duration_seconds, t.is_favorite, t.segments, t.transcript_text, t.content_version,
         (t.title ilike p.pat) as title_match,
         ((case when numnode(p.q) > 0 and t.search_tsv @@ p.q then ts_rank_cd('{0.02,0.2,0.4,1.0}'::float4[], t.search_tsv, p.q, 1) else 0 end)
          + (case when t.title ilike p.pat then 10 else 0 end)
          + coalesce(0.1 * n.r, 0))::real as score
  from public.transcriptions t
  cross join params p
  left join by_notes n on n.id = t.id
  where t.user_id = p.uid
    and t.id in (select id from by_content union select id from by_title union select id from by_notes)
  order by score desc, t.created_at desc
  limit least(greatest(coalesce(p_limit, 10), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0)
)
select c.id, c.title,
       case when c.recording_type in ('lecture', 'meeting', 'interview', 'podcast', 'voice_message') then c.recording_type end,
       c.created_at, c.duration_seconds, c.is_favorite, c.title_match,
       not seg.has_segments, c.score, coalesce(th.cnt, 0)::integer,
       coalesce(th.hits, ta.hits, '[]'::jsonb) || coalesce(nh.hits, '[]'::jsonb),
       coalesce(th.cnt, 0) = 0 and ta.hits is not null
from cand c
cross join params p
cross join lateral (
  select coalesce(jsonb_typeof(c.segments) = 'array' and jsonb_array_length(c.segments) > 0, false) as has_segments
) seg
-- transcript lines (or, for older saves, paragraphs) that contain the query
cross join lateral (
  select count(*) as cnt,
         jsonb_agg(jsonb_build_object(
           'source', 'transcript', 'line', z.line, 'start', z.start, 'speaker', z.speaker,
           'snippet', ts_headline('english'::regconfig, z.text, p.q,
             format('StartSel=%s, StopSel=%s, MaxWords=30, MinWords=12, ShortWord=2, MaxFragments=1', chr(2), chr(3))))
           order by z.line) filter (where z.rn <= 3) as hits
  from (
    select l.*, row_number() over (order by l.line) as rn
    from (
      select (x.o - 1)::integer as line, (x.e ->> 's')::double precision as start, x.e ->> 'sp' as speaker, x.e ->> 't' as text
      from jsonb_array_elements(case when seg.has_segments then c.segments else '[]'::jsonb end) with ordinality as x(e, o)
      union all
      select (x.o - 1)::integer, public.clock_to_seconds(x.m[1]), x.m[2], regexp_replace(x.m[3], '\s*\n\s*', ' ', 'g')
      from regexp_matches(case when seg.has_segments then '' else c.transcript_text end,
                          '\[(\d{1,2}(?::\d{2}){1,2})\] ([^\n]+):\n([^\n]+(?:\n[^\n]+)*)', 'g') with ordinality as x(m, o)
    ) l
    where numnode(p.q) > 0
      and to_tsvector('english'::regconfig,
            (case when l.speaker ~ '^Speaker \d+$' then '' else coalesce(l.speaker, '') end) || ' ' || coalesce(l.text, '')) @@ p.q
  ) z
) th
-- fallback: lines with any of the words, computed only when no single line had all of them
cross join lateral (
  select jsonb_agg(jsonb_build_object(
           'source', 'transcript', 'line', z.line, 'start', z.start, 'speaker', z.speaker,
           'snippet', ts_headline('english'::regconfig, z.text, p.q_any,
             format('StartSel=%s, StopSel=%s, MaxWords=30, MinWords=12, ShortWord=2, MaxFragments=1', chr(2), chr(3))))
           order by z.line) filter (where z.rn <= 3) as hits
  from (
    select l.*, row_number() over (order by l.line) as rn
    from (
      select (x.o - 1)::integer as line, (x.e ->> 's')::double precision as start, x.e ->> 'sp' as speaker, x.e ->> 't' as text
      from jsonb_array_elements(case when th.cnt = 0 and seg.has_segments then c.segments else '[]'::jsonb end) with ordinality as x(e, o)
      union all
      select (x.o - 1)::integer, public.clock_to_seconds(x.m[1]), x.m[2], regexp_replace(x.m[3], '\s*\n\s*', ' ', 'g')
      from regexp_matches(case when th.cnt = 0 and not seg.has_segments then c.transcript_text else '' end,
                          '\[(\d{1,2}(?::\d{2}){1,2})\] ([^\n]+):\n([^\n]+(?:\n[^\n]+)*)', 'g') with ordinality as x(m, o)
    ) l
    where p.q_any is not null
      and to_tsvector('english'::regconfig,
            (case when l.speaker ~ '^Speaker \d+$' then '' else coalesce(l.speaker, '') end) || ' ' || coalesce(l.text, '')) @@ p.q_any
  ) z
) ta
-- generated Notes that match (labelled as Notes, never mixed into transcript hits)
cross join lateral (
  select jsonb_agg(jsonb_build_object('source', 'notes', 'line', w.ref, 'start', w.start, 'speaker', null,
           'snippet', ts_headline('english'::regconfig, w.text, p.q,
             format('StartSel=%s, StopSel=%s, MaxWords=30, MinWords=12, ShortWord=2, MaxFragments=1', chr(2), chr(3))))
           order by w.ord) as hits
  from (
    select it.item ->> 'text' as text,
           (it.item -> 'refs' ->> 0)::integer as ref,
           case when seg.has_segments then (c.segments -> ((it.item -> 'refs' ->> 0)::integer) ->> 's')::double precision end as start,
           row_number() over (order by i.updated_at desc, s.so, it.io) as ord
    from public.transcription_insights i
    cross join lateral jsonb_array_elements(i.content -> 'sections') with ordinality as s(sec, so)
    cross join lateral jsonb_array_elements(s.sec -> 'items') with ordinality as it(item, io)
    where i.transcription_id = c.id and i.user_id = p.uid and i.kind = 'notes' and i.status = 'ready'
      and i.source_version = c.content_version
      and numnode(p.q) > 0
      and to_tsvector('english'::regconfig, regexp_replace(coalesce(it.item ->> 'text', ''), 'Speaker \d+', ' ', 'g')) @@ p.q
  ) w
  where w.ord <= 2
) nh
order by c.score desc, c.created_at desc
$$;
