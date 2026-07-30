-- 0077_job_geofences_route_id.sql
-- Server-side geofence auto-assign (FW-16): adds job_geofences.route_id — the Vonigo ROUTE objectID
-- (numeric, stored as text) for the job's route. job_geofences.route (the NAME) already exists (0044) for
-- the time-at-customer report filter, but route_truck_assignments is keyed on the numeric vonigo_route_id,
-- so the Motive webhook needs the NUMERIC id to auto-assign a truck on first arrival without the board open.
--
-- Populated by crewlogic-job-geofence-sync from crewlogic-todays-workorders' routeID (routeRel.objectID),
-- and refreshed on the sync's idempotent-skip path so a mid-day route change updates the stored id.
--
-- Apply to dev:        bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0077_job_geofences_route_id.sql
-- Apply to prod (gated): bash supabase/dev-setup/prod-write-sql.sh -f supabase/migrations/0077_job_geofences_route_id.sql

alter table public.job_geofences add column if not exists route_id text;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual):
--   alter table public.job_geofences drop column if exists route_id;
