-- 0068_job_source_snapshot.sql
--
-- Provider-specific, read-only DR snapshot for IMPORTED (mirror) appointments — FW-58 / Vonigo
-- adapter (docs/contract-vonigo-adapter.md, O1-O4).
--
-- Holds the bits the canonical job model deliberately does NOT carry, so importing Vonigo does not
-- pollute jobs/job_appointments ("adds a CRM = rows, not columns"):
--   O3 import_total  — the amount to collect during an outage (canonical model defers money to the
--                      payments contract; DR needs the number for manual collection).
--   O1 crew_display  — Vonigo crew NAMES for display. NOT job_crew (which needs a native login;
--                      Vonigo crew are Vonigo users with no CrewLogic profile).
--   O2 route_name    — denormalized Vonigo route label (route_id stays NULL unless a native route matches).
--      raw           — full provider WorkOrder payload (fidelity / future fields).
--
-- One row per imported appointment (a Vonigo WorkOrder). Written by the Vonigo adapter (service role);
-- read for the DR board. Additive only. Idempotent. Rollback at the bottom.

create table if not exists public.job_source_snapshot (
  appointment_id  uuid primary key references public.job_appointments(id) on delete cascade,
  franchise_id    uuid not null references public.franchises(id) on delete cascade,   -- denormalized for RLS + index
  provider        text not null default 'vonigo',
  import_total    numeric(12,2),          -- O3: amount to collect (provider total), DR display only
  crew_display    jsonb,                  -- O1: [{id,name,title}] crew names for display (NOT job_crew)
  customer_display jsonb,                 -- {name,phone,email} for DR display — avoids coupling the
                                          -- read-only mirror to native customers dedup/type/source (v1);
                                          -- phone/email fill once the Vonigo field IDs are resolved
  route_name      text,                   -- O2: denormalized route label
  raw             jsonb,                  -- full provider WorkOrder payload
  synced_at       timestamptz,            -- last successful pull of this snapshot ("as of" staleness)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.job_source_snapshot is
  'Read-only provider DR snapshot per imported appointment (Vonigo adapter). Carries import_total (amount to collect), crew display names, route label, and the raw payload — the bits the canonical model omits. Never the source of truth for native jobs.';

create index if not exists job_source_snapshot_franchise_idx on public.job_source_snapshot (franchise_id);

drop trigger if exists job_source_snapshot_touch_updated_at on public.job_source_snapshot;
create trigger job_source_snapshot_touch_updated_at
  before update on public.job_source_snapshot
  for each row execute function public.touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────
-- Franchise-scoped read, same pattern as jobs/job_appointments (current_franchise_id()). No write
-- policy: the Vonigo adapter writes as the service role (bypasses RLS).
alter table public.job_source_snapshot enable row level security;

drop policy if exists job_source_snapshot_sel on public.job_source_snapshot;
create policy job_source_snapshot_sel on public.job_source_snapshot
  for select to authenticated
  using (franchise_id = current_franchise_id());

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- drop table if exists public.job_source_snapshot;
