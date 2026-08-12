-- 0090_telematics_webhook_health.sql
-- Per franchise+provider telematics-webhook health — powers the "alerts not firing" monitor
-- (crewlogic-alert-health). The telematics webhooks upsert here on every inbound post:
--   • an AUTHENTICATED post  → last_ok_at = now, fail_streak = 0
--   • a REJECTED post (bad token) → last_fail_at = now, fail_streak += 1
-- The monitor reads this to catch "the provider IS posting but we're rejecting it" (the Aug-5 #31
-- token-mismatch class) within the hour — instead of waiting for the 24h silence net to notice.
--
-- Why this was needed: the existing crewlogic-fn-health cron only detects GATEWAY 401s
-- (the --no-verify-jwt regression). #31's break was an APPLICATION auth-fail (the gateway was open,
-- the function ran and rejected the token), so nothing flagged it and it went dark for 7 days.

create table if not exists public.telematics_webhook_health (
  franchise_id uuid not null references public.franchises(id) on delete cascade,
  provider     text not null check (provider in ('linxup','motive')),
  last_ok_at   timestamptz,
  last_fail_at timestamptz,
  fail_streak  int  not null default 0,   -- consecutive rejected posts since the last accepted one
  updated_at   timestamptz not null default now(),
  primary key (franchise_id, provider)
);
alter table public.telematics_webhook_health enable row level security;  -- no policy → service-role only (via the webhooks + monitor)

comment on table public.telematics_webhook_health is
  'Per franchise+provider telematics-webhook health. Webhooks upsert last_ok_at on an authenticated post and last_fail_at+fail_streak on a rejected one; crewlogic-alert-health reads it to alert on "provider posting but we are rejecting it". Service-role only.';

-- ── ROLLBACK (manual): drop table public.telematics_webhook_health;
