-- 0080_fn_health_cron.sql
-- FW / ops guard: schedule crewlogic-fn-health to probe the must-be-public WEBHOOKS every 10 minutes
-- and email on a gateway-401 transition (the recurring --no-verify-jwt regression that silently drops
-- Motive/Linxup geofence events fleet-wide — see memory prod-edge-deploys-need-no-verify-jwt).
--
-- Reuses service_health (0065/0069) for transition-only alerting via crewlogic-notify. The function
-- distinguishes a GATEWAY 401 (verify_jwt ON — the failure) from a webhook's own signature 401 by BODY.
--
-- Run ONCE PER ENVIRONMENT (documented, not auto-applied — same pattern as 0065). Replace <PROJECT_REF>:
--   select cron.schedule('crewlogic-fn-health', '*/10 * * * *', $$
--     select net.http_post(
--       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/crewlogic-fn-health',
--       headers := jsonb_build_object('Content-Type','application/json'),
--       body := jsonb_build_object())
--   $$);
-- Disable:  select cron.unschedule('crewlogic-fn-health');

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- select cron.unschedule('crewlogic-fn-health');
