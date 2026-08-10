-- 0087_retire_followups.sql
-- Retire the FIRST follow-up-pipeline attempt (task #28) — `followups` + `followup_events` (migration 0081) and
-- the `crewlogic-followups-sync` edge function. Superseded by the richer `pipeline_items` / `pipeline_touches` /
-- `pipeline_sequences` model (0085/0086) + `crewlogic-pipeline`, which adds multi-touch scheduling and reusable
-- sequences. Same feature, two designs; we keep one.
--
-- ZERO PROD RISK — verified 2026-08-10 before dropping (Owner-approved):
--   • `followups` table does NOT exist in prod (0081 was applied to DEV only, never promoted).
--   • No client wiring: index.html has zero references to followups.
--   • No prod cron runs crewlogic-followups-sync.
--   • Dev held 32 test rows (scheduling-cancels P1) — regenerable, superseded.
-- The audit-log idea (followup_events) is noted to port into the pipeline (touch history) as a follow-up.
--
-- This runs on DEV (dev-sql.sh -f). It is a no-op on prod (IF EXISTS) should it ever be applied there.

DROP TABLE IF EXISTS public.followup_events;
DROP TABLE IF EXISTS public.followups;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual): re-run migration 0081_followups.sql to recreate both tables.
-- (Kept in history; the drop above supersedes it.)
