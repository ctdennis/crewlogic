-- 0062_visit_settlements.sql
--
-- Recycling revenue recorded against a telematics visit.
-- Contract: docs/contract-recycling-revenue.md (Owner-approved 2026-07-20), with one deviation
-- recorded below.
--
-- ── DEVIATION FROM THE CONTRACT, AND WHY ─────────────────────────────────────────────────
-- The contract specified a telematics_visits table carrying a nullable `amount`. Owner then
-- asked for the historical backfill to land in the EXISTING geofence_alerts table ("just load
-- to the same table"), which it did — 1,813 rows, plus the live webhook feed. Building
-- telematics_visits now would mean duplicating ~1,800 visit rows and teaching the webhook to
-- dual-write, for no user-visible gain.
--
-- So visits stay in geofence_alerts and settlements get their own table. This still honours the
-- contract's actual rule (D2: money must not live in an append-only event log that also carries
-- lifecycle and job rows) without duplicating the visits themselves.
--
-- ── PRESENCE IS THE SIGNAL ───────────────────────────────────────────────────────────────
-- The contract used `amount IS NULL` to mean outstanding. A separate table lets us do better:
--   row EXISTS  → collected
--   no row      → still to collect
-- So `amount` is NOT NULL and cannot be accidentally defaulted into "everything looks settled",
-- which was the failure mode D3 was written to prevent. Zero and negative amounts stay real —
-- Owner's own history contains a 0 ("collected nothing") and a -80 ("the recycler charged me").
--
-- ── SURVIVING A BACKFILL RE-IMPORT ───────────────────────────────────────────────────────
-- alert_id is a convenience join and is ON DELETE SET NULL, deliberately NOT CASCADE: the
-- backfill is explicitly designed to be backed out with
--     delete from geofence_alerts where action = 'motive_backfill';
-- and a cascade would silently destroy real money alongside it. The durable identity
-- (provider_event_id, provider_geofence_id, visit_started_at) is stored alongside so a
-- settlement can be re-attached after any re-import, since Motive's event id is stable.
--
-- Additive only. Idempotent.

create table if not exists public.visit_settlements (
  id                    uuid primary key default gen_random_uuid(),
  franchise_id          uuid not null references public.franchises(id) on delete cascade,

  -- Convenience join to the visit. Nullable so a backfill backout cannot take money with it.
  alert_id              bigint references public.geofence_alerts(id) on delete set null,

  -- Durable identity — lets a settlement be re-linked if alert rows are ever re-imported.
  provider              text not null default 'motive',
  provider_event_id     text,
  provider_geofence_id  bigint,
  visit_started_at      timestamptz,

  -- Money. NOT NULL by design: a row means collected (see PRESENCE IS THE SIGNAL above).
  amount                numeric(12,2) not null,
  weight_lbs            numeric(12,2),

  settled_at            timestamptz not null default now(),
  settled_by            uuid references public.profiles(id) on delete set null,
  note                  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- One settlement per visit. Re-entering an amount updates rather than duplicating.
  unique (franchise_id, alert_id)
);

create index if not exists visit_settlements_franchise_idx
  on public.visit_settlements (franchise_id, settled_at desc);
create index if not exists visit_settlements_geofence_idx
  on public.visit_settlements (franchise_id, provider_geofence_id, visit_started_at desc);
-- Re-link path after a re-import.
create index if not exists visit_settlements_event_idx
  on public.visit_settlements (franchise_id, provider_event_id);

-- Defined here rather than assumed. This helper was introduced by 0053_jobs.sql, which is NOT
-- applied to prod — so on dev the trigger below found it and on prod it would have failed
-- mid-migration, after the table was already created. `create or replace` is idempotent and
-- matches 0053 exactly, so applying either migration in either order is safe.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists visit_settlements_touch_updated_at on public.visit_settlements;
create trigger visit_settlements_touch_updated_at
  before update on public.visit_settlements
  for each row execute function public.touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────
-- Shipped with the table, not after. A new table has RLS disabled by default and Supabase
-- exposes public-schema tables through PostgREST, so any gap is a window in which the
-- publishable anon key — which is embedded in the frontend and therefore public — can read or
-- write revenue figures. Fails closed: current_franchise_id() returning NULL yields zero rows.
alter table public.visit_settlements enable row level security;

drop policy if exists visit_settlements_franchise_all on public.visit_settlements;
create policy visit_settlements_franchise_all on public.visit_settlements
  for all
  using      (franchise_id = public.current_franchise_id())
  with check (franchise_id = public.current_franchise_id());

comment on table public.visit_settlements is
  'Recycling revenue collected against a geofence visit. A row EXISTS only when money was received; absence means still to collect. See docs/contract-recycling-revenue.md.';
comment on column public.visit_settlements.amount is
  'Collected amount. NOT NULL — presence of the row is what marks a visit settled. 0 and negatives are real values.';
