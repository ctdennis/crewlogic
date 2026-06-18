# Route Optimizer R1 — Facilities Schema (Draft for approval)

**Status:** Schema-design gate — DRAFT for owner review. **No migration applied yet.**
**Created:** 2026-06-18 · **Owner:** charles.dennis@junkluggers.com
**Parent:** `docs/plan-route-optimizer-r1.md` · **Rule:** memory `ask-before-json-blob-features`

Move facilities (disposal/recycling/donation sites) out of the `franchises.cost_settings`
**JSONB blob** into proper relational tables — so we can query "open now," accept bulk imports, and
hang the future geofence wait-time **time-series** off a real foreign key. Per `ask-before-json-blob`,
everything structured here is relational; the one remaining JSONB-vs-table choice is flagged in §6.

Next migration number: **`0023_facilities.sql`**.

---

## 1. `facilities` (core entity)

```sql
create table public.facilities (
  id            uuid primary key default gen_random_uuid(),
  franchise_id  uuid not null references public.franchises(id) on delete cascade,
  type          text not null check (type in ('disposal','recycling','donation')),
  name          text not null default '',
  address       text not null default '',
  latitude      double precision,           -- geocoded (cache; null until resolved)
  longitude     double precision,
  per_ton_rate  numeric,                     -- disposal: $/ton cost. recycling: $/truck revenue (sign per type)
  minimum_type  text not null default 'none' check (minimum_type in ('none','weight','dollar')),
  minimum_value numeric,                     -- tons if weight, $ if dollar, null if none
  is_default    boolean not null default false,
  is_active     boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index facilities_franchise_type_idx on public.facilities (franchise_id, type);
alter table public.facilities enable row level security;
-- Service-role only: all client access via the crewlogic-settings edge fn (matches usage_events /
-- telematics_credentials). No client-facing policies → PostgREST denies direct access.
```

## 2. `facility_hours` (relational hours — recommended over JSONB)

```sql
create table public.facility_hours (
  facility_id uuid not null references public.facilities(id) on delete cascade,
  dow         smallint not null check (dow between 0 and 6),   -- 0=Sun … 6=Sat
  is_closed   boolean not null default false,
  open_time   time,                                            -- null when closed
  close_time  time,
  primary key (facility_id, dow)
);
alter table public.facility_hours enable row level security;   -- service-role only
```
Defaults seeded per facility on create: Mon–Fri `07:00–16:00`, Sat `07:00–12:00`, Sun closed.
7 rows/facility. Queryable ("is this site open at arrival?") and the same child-of-facility pattern
the future `facility_wait_samples` (geofence) table will follow.

## 3. `franchise_holidays` (relational holidays)

```sql
create table public.franchise_holidays (
  id           uuid primary key default gen_random_uuid(),
  franchise_id uuid not null references public.franchises(id) on delete cascade,
  federal_key  text,          -- e.g. 'thanksgiving' (one row per federal holiday, with is_observed)
  custom_label text,          -- custom local holiday name
  custom_date  date,          -- custom holiday's date
  is_observed  boolean not null default true,   -- federal: closed that day?
  created_at   timestamptz not null default now()
);
create index franchise_holidays_franchise_idx on public.franchise_holidays (franchise_id);
alter table public.franchise_holidays enable row level security;   -- service-role only
```
Federal rows = `federal_key` + `is_observed`; the edge fn resolves each federal holiday's *date for the
current year* in code (e.g. MLK = 3rd Mon of Jan). Custom rows = `custom_label` + `custom_date`.

## 4. Recycling/donation "mirror disposal hours & holidays" flag

A **scalar boolean** `cost_settings.facilitiesInheritDisposalHours` (default true). Per the
ask-before-blob rule, a single scalar toggle in the existing settings JSONB is fine (not structured
data). When true, recycling/donation facilities use the disposal hours/holidays and we skip their own
hours rows. (R1 only computes disposal anyway.)

## 5. RLS + access path

- All three tables: **RLS on, service-role-only** (no client policies). Matches `usage_events` /
  `telematics_credentials`.
- **Writes/reads from the Settings UI** go through the existing **`crewlogic-settings`** edge function
  (new actions: `getFacilities`, `saveFacility`, `deleteFacility`, `getFacilityHours`/`saveFacilityHours`,
  `getHolidays`/`saveHolidays`) — same caller-verified pattern already used there.
- **`crewlogic-route-disposal`** (R1 edge fn) reads `facilities` (type='disposal', is_active),
  `facility_hours`, and `franchise_holidays` via service role.

## 6. The one JSON-vs-table decision to confirm (per your new rule)

**Hours storage:** I've drafted hours as the relational `facility_hours` child table (§2) — aligns with
your rule and the geofence roadmap. The lighter alternative would be a single `hours jsonb` column on
`facilities` (simpler, but a blob we'd never SQL-query). **Recommendation: relational `facility_hours`.**
Confirm, or say you'd rather take the JSONB column for hours.

(Holidays I've kept relational in §3 — custom dates are genuinely row data.)

## 7. Backfill (in the migration)

One-time data move from the blob → tables, per existing franchise:
- `cost_settings.disposalSites[] / recyclingSites[] / donationSites[]` → `facilities` rows (map
  name/address/cost→per_ton_rate/minimumType/minimumValue/isDefault).
- Any `hours` already captured in v5.44.0 site objects → `facility_hours` rows (else seed defaults).
- `cost_settings.disposalHolidays` → `franchise_holidays` rows.
- Leave the blob keys in place (read-stop) until the UI is repointed and verified, then drop them in a
  later cleanup migration (no destructive delete in 0023).

## 8. Sequence (after schema approval)

1. Approve this schema (+ the §6 hours decision).
2. `0023_facilities.sql` (tables + RLS + backfill) → **dev** first, verify, then prod.
3. `crewlogic-settings` facilities/hours/holidays actions (dev).
4. Repoint the v5.44.0 Settings UI from `cost_settings` to the edge-fn/table path (UI widgets unchanged).
5. Then `crewlogic-route-disposal` + the new screen read from the tables.
