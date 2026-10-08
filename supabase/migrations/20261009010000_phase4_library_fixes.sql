-- Phase 4 fixes after testing against real saved recordings:
--   * "coarse" was null (not true) for recordings without line-level segments;
--   * recording types outside the five named ones (older saves used 'upload') count as General: filtered as
--     General, counted as General, and returned as null so no misleading badge is shown.
-- Same signatures as before; grants are unchanged.

create or replace function public.search_library(p_query text, p_limit integer default 10, p_offset integer default 0)
returns table (
  transcription_id uuid, title text, recording_type text, created_at timestamptz, duration_seconds integer,
  is_favorite boolean, title_match boolean, coarse boolean, score real, match_count integer, hits jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
with params as (
  select (select auth.uid()) as uid,
         websearch_to_tsquery('english'::regconfig, left(btrim(coalesce(p_query, '')), 200)) as q,
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
  select i.transcription_id as id, max(ts_rank_cd(i.search_tsv, p.q)) as r
  from public.transcription_insights i, params p
  where p.ok and numnode(p.q) > 0 and i.user_id = p.uid and i.kind = 'notes' and i.search_tsv @@ p.q
  group by i.transcription_id
),
cand as (
  select t.id, t.title, t.recording_type, t.created_at, t.duration_seconds, t.is_favorite, t.segments, t.transcript_text,
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
select c.id, c.title, case when c.recording_type in ('lecture', 'meeting', 'interview', 'podcast', 'voice_message') then c.recording_type end, c.created_at, c.duration_seconds, c.is_favorite, c.title_match,
       not seg.has_segments, c.score, coalesce(th.cnt, 0)::integer,
       coalesce(th.hits, '[]'::jsonb) || coalesce(nh.hits, '[]'::jsonb)
from cand c
cross join params p
cross join lateral (
  select coalesce(jsonb_typeof(c.segments) = 'array' and jsonb_array_length(c.segments) > 0, false) as has_segments
) seg
-- transcript lines (or paragraphs) that match
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
      and numnode(p.q) > 0 and to_tsvector('english'::regconfig, coalesce(it.item ->> 'text', '')) @@ p.q
  ) w
  where w.ord <= 2
) nh
order by c.score desc, c.created_at desc
$$;

-- ---------------------------------------------------------------------------
-- library_list: one page of the Library with filters and sorting, plus the total for those filters.
--   p_view: 'all' | 'favorites' | 'recent'   p_type: recording type or null ('general' includes unset)
--   p_sort: 'newest' | 'oldest' | 'longest' | 'shortest' | 'az' | 'recent'
-- ---------------------------------------------------------------------------
create or replace function public.library_list(
  p_view text default 'all', p_type text default null, p_folder uuid default null, p_since timestamptz default null,
  p_sort text default 'newest', p_limit integer default 24, p_offset integer default 0
)
returns table (
  id uuid, title text, recording_type text, created_at timestamptz, duration_seconds integer, is_favorite boolean,
  last_opened_at timestamptz, status text, speaker_count integer, coarse boolean, summary text, preview text,
  folder_ids uuid[], total bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
with page as (
  select t.id, t.title, t.recording_type, t.created_at, t.duration_seconds, t.is_favorite, t.last_opened_at, t.status,
         count(*) over () as total
  from public.transcriptions t
  where t.user_id = (select auth.uid())
    and (p_view is distinct from 'favorites' or t.is_favorite)
    and (p_type is null
         or (p_type = 'general' and (t.recording_type is null or t.recording_type not in ('lecture', 'meeting', 'interview', 'podcast', 'voice_message')))
         or t.recording_type = p_type)
    and (p_folder is null or exists (select 1 from public.folder_items fi where fi.folder_id = p_folder and fi.transcription_id = t.id))
    and (p_since is null or t.created_at >= p_since)
  order by
    case when p_sort = 'oldest' then t.created_at end asc,
    case when p_sort = 'longest' then t.duration_seconds end desc nulls last,
    case when p_sort = 'shortest' then t.duration_seconds end asc nulls last,
    case when p_sort = 'az' then lower(t.title) end asc,
    case when p_sort = 'recent' then coalesce(t.last_opened_at, t.created_at) end desc,
    t.created_at desc
  limit least(greatest(coalesce(p_limit, 24), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0)
)
select pg.id, pg.title, case when pg.recording_type in ('lecture', 'meeting', 'interview', 'podcast', 'voice_message') then pg.recording_type end, pg.created_at, pg.duration_seconds, pg.is_favorite, pg.last_opened_at, pg.status,
       (case when seg.has_segments
             then (select count(distinct e ->> 'sp') from jsonb_array_elements(t.segments) e where e ->> 'sp' <> 'Unknown')
             else (select count(distinct m[1]) from regexp_matches(t.transcript_text, '^\[\d{1,2}(?::\d{2}){1,2}\] ([^\n]+):$', 'gn') m
                   where m[1] <> 'Unknown') end)::integer,
       not seg.has_segments,
       (select i.content ->> 'short_summary' from public.transcription_insights i
         where i.transcription_id = pg.id and i.kind = 'overview' and i.status = 'ready'
         order by i.updated_at desc limit 1),
       left(case when seg.has_segments then t.segments -> 0 ->> 't'
                 else substring(t.transcript_text from '\][^\n]*:\n([^\n]+)') end, 240),
       array(select fi.folder_id from public.folder_items fi where fi.transcription_id = pg.id),
       pg.total
from page pg
join public.transcriptions t on t.id = pg.id
cross join lateral (select coalesce(jsonb_typeof(t.segments) = 'array' and jsonb_array_length(t.segments) > 0, false) as has_segments) seg
order by
  case when p_sort = 'oldest' then pg.created_at end asc,
  case when p_sort = 'longest' then pg.duration_seconds end desc nulls last,
  case when p_sort = 'shortest' then pg.duration_seconds end asc nulls last,
  case when p_sort = 'az' then lower(pg.title) end asc,
  case when p_sort = 'recent' then coalesce(pg.last_opened_at, pg.created_at) end desc,
  pg.created_at desc
$$;

-- ---------------------------------------------------------------------------
-- library_stats: the small overview in the Library header
-- ---------------------------------------------------------------------------
create or replace function public.library_stats(p_month_start timestamptz default null)
returns table (recordings bigint, seconds bigint, this_month bigint, favorites bigint, by_type jsonb)
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*),
         coalesce(sum(t.duration_seconds), 0)::bigint,
         count(*) filter (where t.created_at >= coalesce(p_month_start, date_trunc('month', now()))),
         count(*) filter (where t.is_favorite),
         coalesce((select jsonb_object_agg(k.type, k.n) from (
                     select case when x.recording_type in ('lecture', 'meeting', 'interview', 'podcast', 'voice_message') then x.recording_type else 'general' end as type, count(*) as n
                     from public.transcriptions x where x.user_id = (select auth.uid()) group by 1) k), '{}'::jsonb)
  from public.transcriptions t
  where t.user_id = (select auth.uid())
$$;
