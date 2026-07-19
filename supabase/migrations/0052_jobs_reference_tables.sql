-- 0052_jobs_reference_tables.sql
--
-- Reference data for native jobs: marketing sources, generic pick-lists, and routes.
-- Contract: docs/contract-jobs-schema.md §3.5, §3.6 (Owner-approved 2026-07-19).
--
-- WHY RELATIONAL (decision D4): marketing source / dwelling type / parking / item location /
-- lost + cancel reasons are tenant-CONFIGURABLE and REPORTABLE. Marketing source especially --
-- attribution reporting is the entire reason for capturing it, and you cannot group by a JSON
-- blob field. This also gives ServiceTitan's tenant-configured businessUnitId / jobTypeId /
-- campaignId / tagTypeIds somewhere to sync into later.
--
-- One generic `job_pick_options` table (discriminated by `category`) rather than five
-- near-identical tables. Categories are closed by CHECK so a typo cannot silently create a
-- new category that no UI reads.
--
-- Idempotent: guarded by `if not exists`; safe to re-run.

-- ─────────────────────────────────────────────────────────────────────────────
-- marketing_sources — "how did you hear about us"
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.marketing_sources (
  id            uuid primary key default gen_random_uuid(),
  franchise_id  uuid not null references public.franchises(id) on delete cascade,
  name          text not null,
  is_active     boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  unique (franchise_id, name)
);

create index if not exists marketing_sources_franchise_idx
  on public.marketing_sources (franchise_id, is_active, sort_order);

-- ─────────────────────────────────────────────────────────────────────────────
-- job_pick_options — generic tenant-configurable pick lists
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.job_pick_options (
  id            uuid primary key default gen_random_uuid(),
  franchise_id  uuid not null references public.franchises(id) on delete cascade,
  category      text not null,
  name          text not null,
  is_active     boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  unique (franchise_id, category, name),
  constraint job_pick_options_category_chk check (category in (
    'dwelling_type', 'parking', 'item_location', 'lost_reason', 'cancel_reason'
  ))
);

create index if not exists job_pick_options_lookup_idx
  on public.job_pick_options (franchise_id, category, is_active, sort_order);

-- ─────────────────────────────────────────────────────────────────────────────
-- routes — native route lanes for the dispatch board
-- ─────────────────────────────────────────────────────────────────────────────
-- Vonigo has first-class routes; ServiceTitan has NO route entity (it uses Business Unit /
-- Zone / Team), so a ServiceTitan-sourced appointment simply leaves route_id NULL. The board
-- is route-laned, so this ships now rather than as a later migration.
create table if not exists public.routes (
  id            uuid primary key default gen_random_uuid(),
  franchise_id  uuid not null references public.franchises(id) on delete cascade,
  name          text not null,
  short_code    text,
  color         text,
  is_active     boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  unique (franchise_id, name)
);

create index if not exists routes_franchise_idx
  on public.routes (franchise_id, is_active, sort_order);

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed defaults for every EXISTING franchise
-- ─────────────────────────────────────────────────────────────────────────────
-- Sensible starting lists so a native franchise is not staring at empty dropdowns on day one.
-- Every row is editable/deactivatable by the franchise. Seeding is idempotent via the unique
-- constraints + `on conflict do nothing`.
--
-- NOTE: no routes are seeded -- route names are franchise-specific (e.g. #90 uses MA3ALL /
-- RI4REG) and inventing them would be noise. Franchises create their own.

insert into public.marketing_sources (franchise_id, name, sort_order)
select f.id, v.name, v.ord
from public.franchises f
cross join (values
  ('Google', 10), ('Referral', 20), ('Repeat customer', 30), ('Yard sign', 40),
  ('Facebook', 50), ('Nextdoor', 60), ('Truck / vehicle wrap', 70), ('Other', 999)
) as v(name, ord)
on conflict (franchise_id, name) do nothing;

insert into public.job_pick_options (franchise_id, category, name, sort_order)
select f.id, v.category, v.name, v.ord
from public.franchises f
cross join (values
  ('dwelling_type', 'Home',            10),
  ('dwelling_type', 'Apartment',       20),
  ('dwelling_type', 'Office',          30),
  ('dwelling_type', 'Retail',          40),
  ('dwelling_type', 'Warehouse',       50),
  ('dwelling_type', 'Storage unit',    60),
  ('dwelling_type', 'Other',          999),

  ('parking',       'Driveway',         10),
  ('parking',       'Street',           20),
  ('parking',       'Parking lot',      30),
  ('parking',       'Loading dock',     40),
  ('parking',       'Alley',            50),
  ('parking',       'Other',           999),

  ('item_location', 'Outside',          10),
  ('item_location', 'Garage',           20),
  ('item_location', '1st floor',        30),
  ('item_location', '2nd floor',        40),
  ('item_location', '3rd floor+',       50),
  ('item_location', 'Basement',         60),
  ('item_location', 'Attic',            70),
  ('item_location', 'Storage unit',     80),

  ('lost_reason',   'Price too high',   10),
  ('lost_reason',   'Went with competitor', 20),
  ('lost_reason',   'Customer did it themselves', 30),
  ('lost_reason',   'No longer needed', 40),
  ('lost_reason',   'Unresponsive',     50),
  ('lost_reason',   'Other',           999),

  ('cancel_reason', 'Customer cancelled', 10),
  ('cancel_reason', 'Rescheduled',        20),
  ('cancel_reason', 'Weather',            30),
  ('cancel_reason', 'Crew unavailable',   40),
  ('cancel_reason', 'Duplicate booking',  50),
  ('cancel_reason', 'Other',             999)
) as v(category, name, ord)
on conflict (franchise_id, category, name) do nothing;
