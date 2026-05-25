-- DB setup for crewlogic-signs-lifecycle (migrated from n8n "Signs - Daily Lifecycle").
-- Single set-based function does the per-franchise aging for all franchises at once;
-- the edge function runs it + posts an optional Slack summary. pg_cron triggers daily.
--
-- Run: supabase db query --linked -f supabase/functions/crewlogic-signs-lifecycle/setup.sql
-- (replace <SUPABASE_ANON_KEY> below — it's the public anon key).

-- active -> gray after graySignDays (default 15), gray -> hidden after hiddenSignDays
-- (default 60); per-franchise thresholds from cost_settings->signs. Each transition is
-- logged to sign_status_events. Both UPDATEs read the statement-start snapshot, so a
-- sign moves at most one step per run (matches the original n8n statement).
create or replace function public.signs_daily_lifecycle()
returns table (grayed_count bigint, hidden_count bigint)
language sql security definer set search_path = public as $$
  with to_gray as (
    update yard_signs ys set status='gray', updated_at=now() from franchises f
    where ys.franchise_id=f.id and ys.status='active'
      and ys.placed_at < now() - (coalesce((f.cost_settings->'signs'->>'graySignDays')::int,15)||' days')::interval
    returning ys.id, ys.franchise_id
  ),
  gray_events as (
    insert into sign_status_events (franchise_id, sign_id, from_status, to_status, event_type)
    select franchise_id, id, 'active','gray','auto_aged' from to_gray returning 1
  ),
  to_hidden as (
    update yard_signs ys set status='hidden', updated_at=now() from franchises f
    where ys.franchise_id=f.id and ys.status='gray'
      and ys.placed_at < now() - (coalesce((f.cost_settings->'signs'->>'hiddenSignDays')::int,60)||' days')::interval
    returning ys.id, ys.franchise_id
  ),
  hidden_events as (
    insert into sign_status_events (franchise_id, sign_id, from_status, to_status, event_type)
    select franchise_id, id, 'gray','hidden','auto_aged' from to_hidden returning 1
  )
  select (select count(*) from to_gray)::bigint, (select count(*) from to_hidden)::bigint;
$$;

-- Daily at 22:00 UTC (matches the n8n 6pm-EST cron). Requires pg_net (enabled by the
-- photo-sweep setup). Re-running cron.schedule with the same name updates the job.
select cron.schedule(
  'crewlogic-signs-lifecycle-daily',
  '0 22 * * *',
  $cron$
    select net.http_post(
      url := 'https://ozfkpxyachigfpcmvekz.supabase.co/functions/v1/crewlogic-signs-lifecycle',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer <SUPABASE_ANON_KEY>',
        'apikey', '<SUPABASE_ANON_KEY>'
      ),
      body := '{}'::jsonb
    );
  $cron$
);
