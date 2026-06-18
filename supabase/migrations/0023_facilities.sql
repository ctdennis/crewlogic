-- 0023_facilities.sql — move facilities (disposal/recycling/donation sites), their hours, and
-- franchise holidays out of the franchises.cost_settings JSONB blob into relational tables.
-- Per docs/plan-route-optimizer-r1-schema.md (§6 APPROVED: relational facility_hours, NOT a JSONB hours column).
-- Non-destructive: the cost_settings blob keys are LEFT IN PLACE (read-stop) until the UI is repointed;
-- a later cleanup migration drops them.
-- Idempotent-safe: create table if not exists; backfill guarded so a re-run won't duplicate rows.

-- ── §1. facilities (core entity) ────────────────────────────────────────────
create table if not exists public.facilities (
  id            uuid primary key default gen_random_uuid(),
  franchise_id  uuid not null references public.franchises(id) on delete cascade,
  type          text not null check (type in ('disposal','recycling','donation')),
  name          text not null default '',
  address       text not null default '',
  latitude      double precision,           -- geocoded (cache; null until resolved)
  longitude     double precision,
  per_ton_rate  numeric,                     -- disposal: $/ton cost. recycling: $/truck revenue. donation: null.
  minimum_type  text not null default 'none' check (minimum_type in ('none','weight','dollar')),
  minimum_value numeric,                     -- tons if weight, $ if dollar, null if none
  is_default    boolean not null default false,
  is_active     boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists facilities_franchise_type_idx on public.facilities (franchise_id, type);
alter table public.facilities enable row level security;
-- No client policies: service-role only; all client access via the crewlogic-settings edge fn
-- (same pattern as usage_events / telematics_credentials). PostgREST denies direct client access.

-- ── §2. facility_hours (relational hours — §6 APPROVED) ─────────────────────
create table if not exists public.facility_hours (
  facility_id uuid not null references public.facilities(id) on delete cascade,
  dow         smallint not null check (dow between 0 and 6),   -- 0=Sun … 6=Sat
  is_closed   boolean not null default false,
  open_time   time,                                            -- null when closed
  close_time  time,
  primary key (facility_id, dow)
);
alter table public.facility_hours enable row level security;
-- No client policies: service-role only; access via crewlogic-settings edge fn.

-- ── §3. franchise_holidays (relational holidays) ────────────────────────────
create table if not exists public.franchise_holidays (
  id           uuid primary key default gen_random_uuid(),
  franchise_id uuid not null references public.franchises(id) on delete cascade,
  federal_key  text,          -- e.g. 'thanksgiving' (one row per federal holiday, with is_observed)
  custom_label text,          -- custom local holiday name
  custom_date  date,          -- custom holiday's date
  is_observed  boolean not null default true,   -- federal: closed that day?
  created_at   timestamptz not null default now()
);
create index if not exists franchise_holidays_franchise_idx on public.franchise_holidays (franchise_id);
alter table public.franchise_holidays enable row level security;
-- No client policies: service-role only; access via crewlogic-settings edge fn.

-- ── §7. Backfill: facilities (one row per site object) ──────────────────────
-- Guarded: only backfill a franchise that currently has ZERO facility rows. Single statement,
-- so all three type-branches see the same pre-insert snapshot.
insert into public.facilities
  (franchise_id, type, name, address, per_ton_rate, minimum_type, minimum_value, is_default, sort_order)
select x.franchise_id,
       x.type,
       coalesce(x.s->>'name',''),
       coalesce(x.s->>'address',''),
       case x.type
         when 'disposal'  then nullif(x.s->>'cost','')::numeric
         when 'recycling' then nullif(x.s->>'revenue','')::numeric
         else null
       end,
       coalesce(nullif(x.s->>'minimumType',''),'none'),
       nullif(x.s->>'minimumValue','')::numeric,
       coalesce((x.s->>'isDefault')::boolean, false),
       (x.ord)::int
from (
  select f.id as franchise_id, 'disposal'::text as type, e.s, e.ord
  from public.franchises f,
       lateral jsonb_array_elements(f.cost_settings->'disposalSites') with ordinality as e(s, ord)
  where jsonb_typeof(f.cost_settings->'disposalSites') = 'array'
    and not exists (select 1 from public.facilities fac where fac.franchise_id = f.id)
  union all
  select f.id, 'recycling', e.s, e.ord
  from public.franchises f,
       lateral jsonb_array_elements(f.cost_settings->'recyclingSites') with ordinality as e(s, ord)
  where jsonb_typeof(f.cost_settings->'recyclingSites') = 'array'
    and not exists (select 1 from public.facilities fac where fac.franchise_id = f.id)
  union all
  select f.id, 'donation', e.s, e.ord
  from public.franchises f,
       lateral jsonb_array_elements(f.cost_settings->'donationSites') with ordinality as e(s, ord)
  where jsonb_typeof(f.cost_settings->'donationSites') = 'array'
    and not exists (select 1 from public.facilities fac where fac.franchise_id = f.id)
) x;

-- ── §7. Backfill: facility_hours — seed 7 default rows per facility ──────────
-- Defaults: Mon–Fri 07:00–16:00, Sat 07:00–12:00, Sun closed. (dow 0=Sun..6=Sat)
-- Guarded per facility (skip any facility that already has hours rows).
insert into public.facility_hours (facility_id, dow, is_closed, open_time, close_time)
select fac.id, d.dow, d.is_closed, d.open_time, d.close_time
from public.facilities fac
cross join (values
  (0::smallint, true,  null::time,        null::time),         -- Sun closed
  (1::smallint, false, '07:00'::time,     '16:00'::time),      -- Mon
  (2::smallint, false, '07:00'::time,     '16:00'::time),      -- Tue
  (3::smallint, false, '07:00'::time,     '16:00'::time),      -- Wed
  (4::smallint, false, '07:00'::time,     '16:00'::time),      -- Thu
  (5::smallint, false, '07:00'::time,     '16:00'::time),      -- Fri
  (6::smallint, false, '07:00'::time,     '12:00'::time)       -- Sat
) as d(dow, is_closed, open_time, close_time)
where not exists (select 1 from public.facility_hours fh where fh.facility_id = fac.id);

-- ── §7. Backfill: facility_hours — overlay any hours captured in the source blob ─
-- Match each facility back to its source site object via (franchise_id, type, sort_order=ordinality).
-- Day keys map mon→1,tue→2,wed→3,thu→4,fri→5,sat→6,sun→0. Idempotent (re-applies same source values).
update public.facility_hours fh
set is_closed  = coalesce((hr.day->>'closed')::boolean, false),
    open_time  = case when coalesce((hr.day->>'closed')::boolean, false)
                      then null else nullif(hr.day->>'open','')::time end,
    close_time = case when coalesce((hr.day->>'closed')::boolean, false)
                      then null else nullif(hr.day->>'close','')::time end
from (
  select fac.id as facility_id,
         m.dow,
         src.s->'hours'->m.daykey as day
  from public.facilities fac
  join lateral (
    select e.s
    from public.franchises f,
         lateral jsonb_array_elements(
           case fac.type
             when 'disposal'  then f.cost_settings->'disposalSites'
             when 'recycling' then f.cost_settings->'recyclingSites'
             else                  f.cost_settings->'donationSites'
           end
         ) with ordinality as e(s, ord)
    where f.id = fac.franchise_id
      and e.ord = fac.sort_order
  ) src on true
  cross join (values
    (0::smallint,'sun'),(1::smallint,'mon'),(2::smallint,'tue'),(3::smallint,'wed'),
    (4::smallint,'thu'),(5::smallint,'fri'),(6::smallint,'sat')
  ) as m(dow, daykey)
  where jsonb_typeof(src.s->'hours') = 'object'
    and (src.s->'hours') ? m.daykey
) hr
where fh.facility_id = hr.facility_id
  and fh.dow = hr.dow;

-- ── §7. Backfill: franchise_holidays — federal (one row per federal key) ────
-- Guarded per franchise (skip any franchise that already has federal rows).
insert into public.franchise_holidays (franchise_id, federal_key, is_observed)
select f.id, fed.key, coalesce((fed.value #>> '{}')::boolean, true)
from public.franchises f,
     lateral jsonb_each(f.cost_settings->'disposalHolidays'->'federal') as fed(key, value)
where jsonb_typeof(f.cost_settings->'disposalHolidays'->'federal') = 'object'
  and not exists (
    select 1 from public.franchise_holidays h
    where h.franchise_id = f.id and h.federal_key is not null
  );

-- ── §7. Backfill: franchise_holidays — custom (one row per {name,date}) ─────
-- Guarded per franchise (skip any franchise that already has custom rows).
insert into public.franchise_holidays (franchise_id, custom_label, custom_date)
select f.id, c->>'name', nullif(c->>'date','')::date
from public.franchises f,
     lateral jsonb_array_elements(f.cost_settings->'disposalHolidays'->'custom') as c
where jsonb_typeof(f.cost_settings->'disposalHolidays'->'custom') = 'array'
  and not exists (
    select 1 from public.franchise_holidays h
    where h.franchise_id = f.id and h.custom_label is not null
  );

-- ── Rollback ────────────────────────────────────────────────────────────────
-- drop table if exists public.facility_hours;
-- drop table if exists public.franchise_holidays;
-- drop table if exists public.facilities;
-- (cost_settings blob keys were never modified, so no data restore is needed on rollback.)
