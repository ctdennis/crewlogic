-- 0094_pipeline_sync_cron.sql  (PROD cron — apply to prod only, via prod-write-sql.sh -f)
--
-- Biz Dev reads pipeline_items; nothing refreshed that table on its own — it only updated when someone hit
-- "Sync now" in the Follow-up Pipeline, so Biz Dev could show stale data (cancelled/duplicate jobs lingering).
-- This cron runs the pipeline `sync` every 15 min for each pipeline-active Vonigo franchise, matching the
-- crewlogic-vonigo-sync mirror cadence, so pipeline_items self-refreshes and Biz Dev stays a fast read.
--
-- Auth: the PUBLIC publishable/anon key (already shipped in index.html) — passes the gateway verify-jwt without
-- opening the function. NOT a secret. Scope: franchises that already have pipeline_items (i.e. active Biz Dev
-- users) so we don't hit Vonigo for franchises not using it; auto-broadens as Biz Dev rolls out.
--
-- ENV-SPECIFIC: this file carries the PROD project URL + PROD anon key. The DEV cron was created separately
-- with the dev URL/key (supabase/dev-setup, applied via dev-sql). Do NOT run this file against dev.

select cron.schedule('crewlogic-pipeline-sync', '*/15 * * * *', $CRON$
  select net.http_post(
    url := 'https://ozfkpxyachigfpcmvekz.supabase.co/functions/v1/crewlogic-pipeline',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer sb_publishable_Jcy2e2s2x12kY0Az6jGzUw_Jn3ikNpt',
      'apikey','sb_publishable_Jcy2e2s2x12kY0Az6jGzUw_Jn3ikNpt'
    ),
    body := jsonb_build_object('franchiseID', f.external_id, 'action', 'sync')
  )
  from public.franchises f
  join public.tenants t on t.id = f.tenant_id
  where (t.submission_target = 'vonigo' or t.pricing_source = 'vonigo')
    and exists (select 1 from public.pipeline_items pi where pi.franchise_id = f.id);
$CRON$);

-- Rollback:
--   select cron.unschedule('crewlogic-pipeline-sync');
