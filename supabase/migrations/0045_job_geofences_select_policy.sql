-- 0045_job_geofences_select_policy.sql
-- Adds a franchise-scoped SELECT policy on job_geofences so the client can read it.
--
-- Why: the Phase-4 time-at-customer report maps wo_id -> route from job_geofences. RLS is ON for
-- job_geofences but it had NO policies, so authenticated clients got zero rows (route always blank).
-- This mirrors the existing geofence_alerts_sel policy exactly: authenticated users may read only
-- their own franchise's rows (franchise_id = current_franchise_id()). No write access is granted.
--
-- Idempotent: drop-if-exists then create.
--
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0045_job_geofences_select_policy.sql
-- Apply to prod (gated): supabase db query --linked -f supabase/migrations/0045_job_geofences_select_policy.sql

drop policy if exists job_geofences_sel on public.job_geofences;
create policy job_geofences_sel on public.job_geofences
  for select to authenticated
  using (franchise_id = current_franchise_id());

-- ROLLBACK (manual):
--   drop policy if exists job_geofences_sel on public.job_geofences;
