-- 0095_vonigo_outages.sql
-- Vonigo outage history for the Disaster Recovery screen's "known outages" log.
-- Auto-populated by crewlogic-vonigo-health on confirmed up/down TRANSITIONS: an outage row opens on
-- up->down (the 3rd consecutive failed check) and closes on down->up (first success), with a duration.
-- GLOBAL per service -- mirrors service_health (there is no tenant dimension in the health subsystem).

create table if not exists public.vonigo_outages (
  id               uuid primary key default gen_random_uuid(),
  service          text not null default 'vonigo',
  started_at       timestamptz not null,
  ended_at         timestamptz,                  -- null while the outage is ongoing
  duration_seconds integer,                      -- set when the outage closes (ended_at - started_at)
  detail           text,                         -- health.detail snapshot at open (why we flagged it down)
  source           text not null default 'auto', -- 'auto' (health cron) | 'manual'
  created_at       timestamptz not null default now()
);

create index if not exists vonigo_outages_service_started_idx
  on public.vonigo_outages (service, started_at desc);

-- At most one OPEN outage per service at a time (guards a double-open if a transition fires twice).
create unique index if not exists vonigo_outages_one_open_per_service
  on public.vonigo_outages (service) where ended_at is null;

-- Service-role only: the read path is crewlogic-jobs using the service key (same as service_health).
-- RLS on with NO public policy => anon/authenticated get nothing; the service role bypasses RLS.
alter table public.vonigo_outages enable row level security;
