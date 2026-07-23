-- 0069_service_health_fail_streak.sql
--
-- Adds a consecutive-failure counter to service_health so the health monitor requires N successive
-- DOWN checks before it flips state and alerts (debounce against transient blips).
--
-- Owner 2026-07-23: "3 successive failures before it sends notifications." Combined with the
-- 1-minute cron, a real outage confirms in ~3 minutes while a single blip never pages. Recovery
-- still alerts on the FIRST success (fast to clear, slow to alarm).
--
-- Additive, idempotent.

alter table public.service_health add column if not exists fail_streak integer not null default 0;

comment on column public.service_health.fail_streak is
  'Consecutive DOWN checks. is_up flips to false (and alerts) only after >=3; resets to 0 on any success.';

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- alter table public.service_health drop column if exists fail_streak;
