-- 0063_facility_settlement_mode.sql
--
-- Which way money moves at a facility.
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────
-- `facilities.type` answers "what happens to the material" (disposal / recycling / donation).
-- It does NOT answer "what happens to the money", and the recycling revenue screen was built
-- assuming every recycler pays us. That assumption is wrong for this franchise today:
--
--   metal      (Zion, A&E, Sims, Santos, Atlantic, Mid City)  → they pay us
--   mattress   (HandUp)                                       → we pay them
--   electronics                                               → we pay them
--   tires      (Bob's Tire)                                   → we pay them
--   cardboard  (PF Trading, Miller, Berger) and pallets       → no money either way
--
-- Without this column every one of those non-metal recyclers shows up as "still to collect",
-- i.e. as money owed that will never arrive — the outstanding figure would be permanently and
-- silently overstated, which is the one number this feature exists to get right.
--
-- ── WHY NOT DERIVE IT FROM THE NAME ──────────────────────────────────────────────────────
-- Motive's category is plain "Recycling" for all of them; the distinction only lives in the
-- geofence NAME ("Recycling: Metal", "Recycling: Cardboard"). Parsing that is the exact
-- name-dependence 0056 removed when facilities moved onto the stable geofence id — Bob's Tire
-- was reclassified and renamed in Motive while keeping geofence 2892241. So this is set
-- deliberately in CrewLogic, per facility, and survives any rename upstream.
--
-- ── DEFAULTS ARE TYPE-AWARE, NOT BLANK ───────────────────────────────────────────────────
-- Backfilled from `type` so existing rows land on the truth for the common case rather than on
-- NULL: disposal always costs, donation is always free, recycling defaults to revenue (the
-- majority, and it preserves today's screen behaviour exactly). Only the handful of non-metal
-- recyclers need reclassifying by hand, and they are visible in Settings → Cost → Facilities.
--
-- Note the column default is 'revenue' only because recycling is the type that reaches this
-- screen; a NEW disposal facility is set by the app, not by this default.
--
-- Additive only. Idempotent. Rollback at the bottom.

alter table public.facilities
  add column if not exists settlement_mode text not null default 'revenue';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'facilities_settlement_mode_chk'
  ) then
    alter table public.facilities
      add constraint facilities_settlement_mode_chk
      check (settlement_mode in ('revenue', 'cost', 'none'));
  end if;
end $$;

-- Backfill from type. Guarded so re-running cannot stomp a deliberate reclassification:
-- only rows still sitting on the raw column default are touched.
update public.facilities
   set settlement_mode = case type
                           when 'disposal' then 'cost'
                           when 'donation' then 'none'
                           else 'revenue'
                         end
 where settlement_mode = 'revenue'
   and type in ('disposal', 'donation');

create index if not exists facilities_settlement_mode_idx
  on public.facilities (franchise_id, type, settlement_mode);

comment on column public.facilities.settlement_mode is
  'Direction money moves at this facility: revenue = they pay us (metal recyclers), cost = we pay them (mattress, electronics, tires, disposal), none = no money either way (cardboard, pallets, donations). Only revenue facilities appear in the recycling revenue screen. Set in CrewLogic, never derived from the provider geofence name — see 0056.';

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- alter table public.facilities drop constraint if exists facilities_settlement_mode_chk;
-- drop index if exists public.facilities_settlement_mode_idx;
-- alter table public.facilities drop column if exists settlement_mode;
