-- 0044_job_geofences_route.sql
-- Adds job_geofences.route (text) so the Phase-4 time-at-customer report can filter by Vonigo route.
--
-- Why: geofence_alerts has no route (the webhooks don't know it), but the sync DOES have job.route
-- when it creates the fence. Storing it on job_geofences lets the report map wo_id -> route without a
-- Vonigo re-fetch. Populated at create time by crewlogic-job-geofence-sync; historical rows stay null
-- (report shows "—" and they're filterable as unrouted).
--
-- Idempotent; nullable; additive.
--
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0044_job_geofences_route.sql
-- Apply to prod (gated): supabase db query --linked -f supabase/migrations/0044_job_geofences_route.sql

alter table public.job_geofences add column if not exists route text;

-- ROLLBACK (manual):
--   alter table public.job_geofences drop column if exists route;
