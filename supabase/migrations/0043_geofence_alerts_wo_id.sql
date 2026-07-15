-- 0043_geofence_alerts_wo_id.sql
-- Adds geofence_alerts.wo_id + job_id (both text) so per-job time aggregation is clean.
--
-- Why: today the alerts table has no job/wo linkage — the Vonigo WO# only lives inside the
-- geofence_name string ("<client> · #<woID> · <town>"). The Phase 4 time-at-customer report would
-- otherwise have to parse that string. Instead the webhooks now populate wo_id/job_id at insert time:
--   - Motive: resolved from job_geofences via the geofence_id lookup it already does.
--   - Linxup: parsed from the fence name (#<woID>) + job_id looked up from job_geofences.
-- Facility fences (transfer station / recycling / donation) have no "#<woID>" → wo_id stays null,
-- which is exactly how the report distinguishes a CUSTOMER visit (wo_id present) from a FACILITY visit.
--
-- Idempotent (add column if not exists). Nullable — historical rows keep null.
--
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0043_geofence_alerts_wo_id.sql
-- Apply to prod (gated): supabase db query --linked -f supabase/migrations/0043_geofence_alerts_wo_id.sql

alter table public.geofence_alerts add column if not exists wo_id  text;
alter table public.geofence_alerts add column if not exists job_id text;

-- Optional index for the per-job report grouping (cheap; keeps the Phase 4 query fast).
create index if not exists geofence_alerts_wo_id_idx on public.geofence_alerts (franchise_id, wo_id);

-- ROLLBACK (manual):
--   drop index if exists geofence_alerts_wo_id_idx;
--   alter table public.geofence_alerts drop column if exists job_id;
--   alter table public.geofence_alerts drop column if exists wo_id;
