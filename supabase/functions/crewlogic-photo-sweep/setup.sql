-- DB setup for crewlogic-photo-sweep (migrated from n8n "Soft-Delete Photo Sweep").
-- Two helper functions hold the JSONB-walking SQL; the edge function orchestrates
-- (find -> delete from Storage -> prune). pg_cron triggers the edge function daily.
--
-- Run: supabase db query --linked -f supabase/functions/crewlogic-photo-sweep/setup.sql
-- (replace <SUPABASE_ANON_KEY> below first — it's the public anon key).

-- 1) Find expired soft-deleted photos (deletedAt > 30 days ago), grouped per estimate.
create or replace function public.sweep_find_expired_photos()
returns table (estimate_id bigint, franchise_id uuid, expired_paths jsonb)
language sql
security definer
set search_path = public
as $$
  with expanded as (
    select
      e.estimate_id,
      e.franchise_id,
      (dp.deleted_entry->>'path') as path,
      (dp.deleted_entry->>'deletedAt')::timestamptz as deleted_at
    from estimates e
    cross join lateral jsonb_array_elements(e.payload->'charges') as c(charge)
    cross join lateral jsonb_array_elements(coalesce(c.charge->'deletedPhotos', '[]'::jsonb)) as dp(deleted_entry)
    where c.charge->'deletedPhotos' is not null
      and jsonb_array_length(c.charge->'deletedPhotos') > 0
  )
  select expanded.estimate_id, expanded.franchise_id,
         jsonb_agg(expanded.path order by expanded.deleted_at) as expired_paths
  from expanded
  where expanded.deleted_at < (now() - interval '30 days')
  group by expanded.estimate_id, expanded.franchise_id
  order by expanded.estimate_id;
$$;

-- 2) Prune the expired entries from estimates.payload.charges[*].deletedPhotos.
create or replace function public.sweep_prune_expired_photos(p_estimate_id bigint, p_expired_paths jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  update estimates e
  set payload = jsonb_set(
        e.payload, '{charges}',
        (
          select jsonb_agg(
            case when c->'deletedPhotos' is null then c
                 else jsonb_set(c, '{deletedPhotos}',
                        coalesce((
                          select jsonb_agg(dp)
                          from jsonb_array_elements(c->'deletedPhotos') as dp
                          where not (p_expired_paths ? (dp->>'path'))
                        ), '[]'::jsonb))
            end order by idx)
          from jsonb_array_elements(e.payload->'charges') with ordinality as t(c, idx)
        )),
      updated_at = now()
  where e.estimate_id = p_estimate_id;
$$;

-- 3) Enable pg_net and schedule the daily sweep (06:30 UTC, matching the n8n cron).
create extension if not exists pg_net;

select cron.unschedule('crewlogic-photo-sweep-daily')
  where exists (select 1 from cron.job where jobname = 'crewlogic-photo-sweep-daily');

select cron.schedule(
  'crewlogic-photo-sweep-daily',
  '30 6 * * *',
  $cron$
    select net.http_post(
      url := 'https://ozfkpxyachigfpcmvekz.supabase.co/functions/v1/crewlogic-photo-sweep',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer <SUPABASE_ANON_KEY>',
        'apikey', '<SUPABASE_ANON_KEY>'
      ),
      body := '{}'::jsonb
    );
  $cron$
);
