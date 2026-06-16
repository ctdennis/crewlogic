-- 0022_usage_events.sql — append-only usage/metering event log (per-franchise cost + allowance source of truth)
create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  franchise_id uuid,
  user_id uuid,
  event_type text not null,   -- e.g. ai.analyze_estimate | ai.volume_check | ai.classify | ai.job_summary | ai.detect_sign | ai.job_plan | maps.distance_matrix | maps.geocode
  model text,
  units numeric not null default 1,   -- # calls, or # images for a vision call
  metadata jsonb,             -- { images, tokens_in, tokens_out, elements, source, ... }
  created_at timestamptz not null default now()
);
create index if not exists usage_events_franchise_created_idx on public.usage_events (franchise_id, created_at);
create index if not exists usage_events_type_created_idx on public.usage_events (event_type, created_at);
alter table public.usage_events enable row level security;
-- No policies: service-role only (clients can't read/write directly). A future super-admin dashboard reads via an edge fn.
-- Rollback: drop table if exists public.usage_events;
