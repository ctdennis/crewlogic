-- 0088_pipeline_conversion_cache.sql
-- Caches the per-job "did this estimate convert?" verdict derived from the Vonigo EMAIL trail, so the pipeline
-- sync only calls /data/Emails/ for estimates it hasn't recently checked (and never again once converted).
--
-- WHY the email trail: a converted estimate books a SECOND work order (the "-2"), which fires a
-- "New … Work Order, ID: <job>-2" email — created at booking time, so it exists even when the -2 job is
-- future-dated and NOT yet in the local mirror (the case the label heuristic misses, e.g. Prentice 9/5).
-- The mirror sibling-label check (9970/9975) stays the free fast-path; this email check is the fallback for
-- candidates that still look unconverted. `converted=true` is permanent; `false` is re-checked after a TTL.
--
-- Access: RLS on, no policy → service-role only (via crewlogic-pipeline). Keyed by (franchise, Vonigo job id).

create table if not exists public.pipeline_conversion_cache (
  franchise_id    uuid not null references public.franchises(id) on delete cascade,
  job_external_id text not null,                    -- Vonigo job objectID/number (the /data/Emails jobID)
  converted       boolean not null default false,
  checked_at      timestamptz not null default now(),
  primary key (franchise_id, job_external_id)
);
alter table public.pipeline_conversion_cache enable row level security;

comment on table public.pipeline_conversion_cache is
  'Per-job estimate-conversion verdict from the Vonigo email trail (a "-2" New Work Order email = converted). Fallback to the mirror sibling-label check; catches future-dated conversions not yet in the mirror. converted=true is permanent, false re-checked after a TTL. Via crewlogic-pipeline (service role).';

-- ── ROLLBACK (manual): drop table public.pipeline_conversion_cache;
