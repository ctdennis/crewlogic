-- 0041_job_geofences_deleted_reason.sql
-- Adds job_geofences.deleted_reason so the sync can distinguish WHY a geofence was removed:
--   'job_complete' | 'job_cancelled'  — TERMINAL (do not re-create today)
--   'moved_off'                        — job left today's schedule (re-create if it returns)
--   'eod'                              — end-of-day sweep backstop
-- Needed for Phase 2 (reconcile-based move cleanup): the create-pass dedup blocks re-creating a
-- geofence for any WO with a recent row (active OR deleted). Without a reason, a job that moves off
-- today and later moves back would never get a geofence again. The reason lets the dedup block only
-- terminal deletions and allow re-create after a moved_off/eod removal.
--
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0041_job_geofences_deleted_reason.sql
-- Apply to prod (gated): supabase db query --linked -f supabase/migrations/0041_job_geofences_deleted_reason.sql

alter table public.job_geofences add column if not exists deleted_reason text;

-- ROLLBACK (manual):
--   alter table public.job_geofences drop column if exists deleted_reason;
