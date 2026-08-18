-- 0096_backfill_vonigo_outages.sql
-- One-time DATA seed: historical Vonigo outages reconstructed from the CrewLogic "Vonigo is DOWN /
-- back UP" alert emails (range 2026-08-12 .. 2026-08-13), for the period BEFORE the auto-logger (0095)
-- existed. Flap bursts -- where Vonigo recovered then dropped again within <=10 minutes -- are merged
-- into a single outage window; `detail` notes the drop count for merged windows. Times are the alert
-- (confirmed-transition) timestamps in UTC. A lone 2026-07-23 "back UP" with no preceding DOWN is omitted.
-- Idempotent: inserts nothing if any source='backfill' row already exists.

insert into public.vonigo_outages (service, started_at, ended_at, duration_seconds, detail, source)
select v.service, v.started_at::timestamptz, v.ended_at::timestamptz, v.duration_seconds, v.detail, 'backfill'
from (values
  ('vonigo', '2026-08-12T13:29:13Z', '2026-08-12T13:31:09Z', 116, null),
  ('vonigo', '2026-08-12T14:13:13Z', '2026-08-12T14:16:03Z', 170, null),
  ('vonigo', '2026-08-12T14:27:13Z', '2026-08-12T14:28:03Z',  50, null),
  ('vonigo', '2026-08-13T14:51:14Z', '2026-08-13T14:52:01Z',  47, null),
  ('vonigo', '2026-08-13T15:09:13Z', '2026-08-13T15:23:01Z', 828, 'intermittent, 2 drops'),
  ('vonigo', '2026-08-13T15:33:13Z', '2026-08-13T15:46:02Z', 769, 'intermittent, 2 drops')
) as v(service, started_at, ended_at, duration_seconds, detail)
where not exists (select 1 from public.vonigo_outages where source = 'backfill');
