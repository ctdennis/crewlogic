-- 0056_facilities_geofence_key.sql
--
-- Key facilities on the telematics geofence ID instead of their name, and record how each
-- recycler pays.
-- Contract: docs/contract-recycling-revenue.md §3.1 (D1, D6) — Owner-approved 2026-07-20.
--
-- ── D1: WHY THE NAME IS NOT A KEY ────────────────────────────────────────────────────────
-- Owner reclassified "Bob's Tire" from Transfer to Recycling. The NAME changed; the Motive
-- geofence id 2892241 did not. Every history row keyed on the old name orphaned.
-- The owner's own 8-month export shows the hazard at scale: 109 distinct facility NAMES across
-- 108 distinct geofence IDs -- "A&E" appears four ways, "Zions Middleboro" two, "Bob's Tire"
-- three. Names drift; ids do not.
--
-- The id was ALREADY being captured (geofence_alerts.geofence_id, and motive_geofences is keyed
-- on (franchise_id, geofence_id)). It simply died at the frontend, where classification is a
-- case-insensitive SUBSTRING match on names (index.html:9453). These columns are the missing
-- link that lets that matcher be replaced with an id lookup.
--
-- ── D6: WHY payment_terms EXISTS ─────────────────────────────────────────────────────────
-- Owner: "Zions Middleboro Recycling, I pick up whenever I want. All others are paid in cash at
-- the time we do the recycling."
-- These need OPPOSITE report behaviour. For same_day, an aged unpaid visit is an EXCEPTION --
-- cash should already have changed hands, so it means the crew never handed it over or it was
-- never entered. For on_demand, accruing IS the normal state and flagging it would be permanent
-- noise; what matters there is the running balance. Without this column, Zions alone would
-- generate a wall of false alarms with a genuinely missed same-day collection hidden inside it.
--
-- Additive only; no existing column is altered. Idempotent.

alter table public.facilities
  add column if not exists provider              text,
  add column if not exists provider_geofence_id  bigint,
  add column if not exists payment_terms         text not null default 'unknown';

-- One geofence maps to at most one facility per franchise. A site needing TWO geofences (e.g.
-- two entrances) would require a link table -- deliberately not built; see contract Q-R4.
create unique index if not exists facilities_provider_geofence_uidx
  on public.facilities (franchise_id, provider, provider_geofence_id)
  where provider_geofence_id is not null;

-- Lookup path used when resolving an inbound visit to a configured facility.
create index if not exists facilities_geofence_lookup_idx
  on public.facilities (provider_geofence_id)
  where provider_geofence_id is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'facilities_provider_chk') then
    alter table public.facilities
      add constraint facilities_provider_chk
      check (provider is null or provider in ('motive', 'linxup'));
  end if;

  -- same_day  : cash changes hands at the visit (every recycler except Zions today)
  -- on_demand : a balance accrues; Owner collects when they choose (Zions Middleboro)
  -- unknown   : not yet configured -- listed in reports, NEVER flagged, so an unconfigured
  --             facility cannot manufacture false alarms
  if not exists (select 1 from pg_constraint where conname = 'facilities_payment_terms_chk') then
    alter table public.facilities
      add constraint facilities_payment_terms_chk
      check (payment_terms in ('same_day', 'on_demand', 'unknown'));
  end if;
end $$;

comment on column public.facilities.provider_geofence_id is
  'Stable telematics geofence id (e.g. Motive 2892241). THE facility key -- name is a display label only. See contract-recycling-revenue.md D1.';
comment on column public.facilities.payment_terms is
  'same_day = cash at the visit (unpaid is an exception). on_demand = balance accrues, Owner collects at will (unpaid is normal). unknown = list but never flag.';
