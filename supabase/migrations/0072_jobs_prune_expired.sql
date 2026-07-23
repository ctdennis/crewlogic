-- 0072_jobs_prune_expired.sql
--
-- 3-month retention for the DR mirror (owner 2026-07-23). Deletes IMPORTED appointments older than 3
-- months (cascade → snapshots via the job_source_snapshot FK), then removes any imported job left with
-- no appointments. NEVER touches native rows (origin <> 'import'). Keeps the mirror bounded to
-- [today-3mo, +future], matching the nightly deep-backfill's 90-day cap.
--
-- Additive, idempotent. Rollback at the bottom.

create or replace function public.jobs_prune_expired()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n integer;
begin
  -- Old imported appointments (cascades to their job_source_snapshot rows).
  delete from public.job_appointments a
   using public.jobs j
   where a.job_id = j.id
     and j.origin = 'import'
     and a.scheduled_date is not null
     and a.scheduled_date < (current_date - interval '3 months');
  get diagnostics n = row_count;

  -- Imported jobs now left with no appointments.
  delete from public.jobs j
   where j.origin = 'import'
     and not exists (select 1 from public.job_appointments a where a.job_id = j.id);

  return n;
end;
$fn$;

comment on function public.jobs_prune_expired() is
  'DR mirror 3-month retention: deletes imported appointments older than 3 months (cascade → snapshots) + orphaned imported jobs. Never touches native rows. Daily cron.';

revoke all on function public.jobs_prune_expired() from public;
revoke all on function public.jobs_prune_expired() from anon;
revoke all on function public.jobs_prune_expired() from authenticated;

-- ── CRON (scheduled after apply; documented) ─────────────────────────────────────────────
--   select cron.schedule('crewlogic-jobs-prune', '30 4 * * *', $$ select public.jobs_prune_expired() $$);

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- select cron.unschedule('crewlogic-jobs-prune');
-- drop function if exists public.jobs_prune_expired();
