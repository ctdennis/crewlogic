-- 0029_geofence_alerts_display.sql
-- Display phase for the trucks-map geofence-alerts panel:
--   (1) franchise-scoped SELECT policy on geofence_alerts (mirrors the 0008 per-franchise pattern:
--       franchise_id = public.current_franchise_id()), so a signed-in user reads only THEIR alerts.
--   (2) add geofence_alerts to the supabase_realtime publication so new inserts stream to the client.
-- The receiver keeps writing via the service role (bypasses RLS). motive_geofences stays service-role only.
--
-- Apply to dev: bash supabase/dev-setup/dev-sql.sh "<each statement>"

drop policy if exists geofence_alerts_sel on public.geofence_alerts;
create policy geofence_alerts_sel on public.geofence_alerts
  for select to authenticated
  using (franchise_id = public.current_franchise_id());

do $$ begin
  alter publication supabase_realtime add table public.geofence_alerts;
exception when duplicate_object then null; end $$;

-- ROLLBACK (manual):
--   drop policy if exists geofence_alerts_sel on public.geofence_alerts;
--   alter publication supabase_realtime drop table public.geofence_alerts;
