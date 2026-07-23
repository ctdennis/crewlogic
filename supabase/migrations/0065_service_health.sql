-- 0065_service_health.sql
--
-- Tiny state table for external-service health monitoring. One row per monitored service
-- (currently just Vonigo). crewlogic-vonigo-health pings the service on a cron and writes the
-- result here; it emails the owner ONLY on a state TRANSITION (up→down, down→up), so a multi-hour
-- outage is one email, not one every 5 minutes.
--
-- Why a table at all: edge functions are stateless, so "did the state just change?" needs a
-- durable last-known state to compare against. That is the whole job of this table.
--
-- Additive only. Idempotent. Rollback at the bottom.

create table if not exists public.service_health (
  service       text primary key,          -- 'vonigo'
  is_up         boolean not null,
  detail        text,                       -- last probe detail, e.g. "HTTP 522 (HTML)" or "unreachable"
  last_checked  timestamptz not null default now(),
  last_changed  timestamptz not null default now()
);

comment on table public.service_health is
  'External-service up/down state for monitoring. Written by crewlogic-vonigo-health; owner is emailed only on a transition. Operational, not customer data.';

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────
-- Locked by default: the health function uses the service role (bypasses RLS), and the client
-- anon key has no business reading it. Enable RLS with NO policy so anon/authenticated get zero
-- rows. If a user-facing "Vonigo is down" banner is added later, add a narrow read policy then.
alter table public.service_health enable row level security;

-- ── CRON (run once per environment; documented, not auto-applied) ─────────────────────────
-- Ping Vonigo every 5 minutes:
--   select cron.schedule('crewlogic-vonigo-health', '*/5 * * * *', $$
--     select net.http_post(
--       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/crewlogic-vonigo-health',
--       headers := jsonb_build_object('Content-Type','application/json'),
--       body := jsonb_build_object())
--   $$);
-- Disable:  select cron.unschedule('crewlogic-vonigo-health');

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- select cron.unschedule('crewlogic-vonigo-health');
-- drop table if exists public.service_health;
