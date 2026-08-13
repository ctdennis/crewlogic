-- 0092_backfill_contacts_cron.sql
-- Phase 2 of the contact-restore plan: nightly, gradually fill missing phone/email across the WHOLE customer
-- base. Fires crewlogic-vonigo-import { action:'backfillContacts', limit:300 } for every Vonigo franchise.
-- The import mode walks snapshots whose phone is null (newest-synced first — active jobs recover soonest),
-- pulls each client's /data/Contacts/ (time-budgeted, parallel), and UPDATEs only customer_display.
-- Non-destructive (never touches a row that already has a phone). 300/franchise/night keeps Vonigo load light;
-- a franchise with a big history fills over several nights.
--
-- Phase 1 (last week + next week, all franchises, one-shot) is run manually right after the resilient importer
-- deploy — see docs / the session log. This cron is the ongoing Phase-2 tail.
--
-- Run ONCE PER ENVIRONMENT (documented, not auto-applied — same pattern as 0080/0091). Replace <PROJECT_REF>:
--   select cron.schedule('crewlogic-vonigo-backfill-contacts', '0 3 * * *', $$
--     select net.http_post(
--       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/crewlogic-vonigo-import',
--       headers := jsonb_build_object('Content-Type','application/json'),
--       body := jsonb_build_object('franchiseID', f.external_id, 'action','backfillContacts','limit',300))
--     from public.franchises f where f.vonigo_configured = true
--   $$);
-- Disable:  select cron.unschedule('crewlogic-vonigo-backfill-contacts');

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- select cron.unschedule('crewlogic-vonigo-backfill-contacts');
