-- 0046_backfill_geofence_alerts_wo_id.sql
-- One-time backfill: populate geofence_alerts.wo_id for HISTORIC customer-visit rows.
--
-- Why: wo_id was added in Phase 3 (2026-07-15). Job-visit alerts from before then are already
-- correctly labeled job_arrive/job_leave and carry the WO# inside geofence_name
-- ("<client> · #<woID> · <town>"), but wo_id is NULL, so the Phase-4 time-at-customer report
-- (which filters wo_id IS NOT NULL) excludes them. This parses the #<woID> out of the name and
-- fills wo_id so the historic customer visits appear in the report.
--
-- Scope: ONLY rows that are job visits (event_type in job_arrive/job_leave) with a "#<digits>" in
-- the name. Facility visits (geofence_entry/exit, no #) are untouched. Idempotent (wo_id IS NULL only).
-- Also backfills job_id from job_geofences where resolvable. route stays NULL for history (only
-- stored from 2026-07-15 onward) — the report shows "—" for those.
--
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0046_backfill_geofence_alerts_wo_id.sql
-- Apply to prod (gated): supabase db query --linked -f supabase/migrations/0046_backfill_geofence_alerts_wo_id.sql

update public.geofence_alerts
set wo_id = substring(geofence_name from '#([0-9]+)')
where wo_id is null
  and event_type in ('job_arrive', 'job_leave')
  and geofence_name ~ '#[0-9]+';

-- Backfill job_id from the matching job_geofences row where available (nice-to-have; report groups by wo_id).
update public.geofence_alerts ga
set job_id = jg.job_id
from public.job_geofences jg
where ga.job_id is null
  and ga.wo_id is not null
  and ga.franchise_id = jg.franchise_id
  and ga.wo_id = jg.wo_id
  and jg.job_id is not null;

-- ROLLBACK: none needed (additive data fill). To undo the wo_id fill you would need a pre-image;
-- this is a forward-only correction of a column that was NULL for these rows.
