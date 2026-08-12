-- 0091_alert_health_cron.sql
-- Schedule crewlogic-alert-health HOURLY: detect when a franchise's telematics geofence alerts stop firing,
-- and email the owner on the transition. Covers the two failure modes crewlogic-fn-health (0080) can't:
--   • AUTH-FAIL — the provider is posting but we're rejecting the token (telematics_webhook_health, 0090).
--   • SILENCE  — geofences scheduled today but zero arrivals in 24h (the Aug-5 #31 break went 7 days unseen).
-- Reuses service_health (0065/0069) for transition-only alerting via crewlogic-notify (one email per outage).
--
-- Run ONCE PER ENVIRONMENT (documented, not auto-applied — same pattern as 0080). Replace <PROJECT_REF>:
--   select cron.schedule('crewlogic-alert-health', '0 * * * *', $$
--     select net.http_post(
--       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/crewlogic-alert-health',
--       headers := jsonb_build_object('Content-Type','application/json'),
--       body := jsonb_build_object())
--   $$);
-- Disable:  select cron.unschedule('crewlogic-alert-health');

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- select cron.unschedule('crewlogic-alert-health');
