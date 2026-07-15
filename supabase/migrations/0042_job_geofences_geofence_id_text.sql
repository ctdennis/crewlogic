-- 0042_job_geofences_geofence_id_text.sql
-- Widen job_geofences.geofence_id from bigint -> text.
--
-- Why: the per-job geofence engine now supports Linxup as well as Motive. Motive geofence ids
-- are numeric (bigint), but Linxup returns a geofenceUUID (a uuid STRING). The bigint column
-- rejects the UUID ("invalid input syntax for type bigint"), so the Linxup create pass creates
-- the fence in Linxup but then fails to record the tracking row — leaving an orphaned fence.
--
-- Safe: every code path already String()-wraps geofence_id before use (create insert, delete
-- call, encodeURIComponent in the DELETE URL), so text is compatible. Existing Motive numeric
-- ids convert losslessly to their decimal string form.
--
-- Idempotent: only alters when the column is still bigint.
--
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0042_job_geofences_geofence_id_text.sql
-- Apply to prod (gated): supabase db query --linked -f supabase/migrations/0042_job_geofences_geofence_id_text.sql

do $$
begin
  if (
    select data_type from information_schema.columns
    where table_schema = 'public' and table_name = 'job_geofences' and column_name = 'geofence_id'
  ) = 'bigint' then
    alter table public.job_geofences alter column geofence_id type text using geofence_id::text;
  end if;
end $$;

-- ROLLBACK (manual — only safe if NO Linxup UUID values are present in the column):
--   alter table public.job_geofences alter column geofence_id type bigint using geofence_id::bigint;
