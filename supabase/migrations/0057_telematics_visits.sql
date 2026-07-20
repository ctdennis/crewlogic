-- 0057_telematics_visits.sql
--
-- One row per COMPLETED geofence dwell, plus the recycling settlement recorded against it.
-- Contract: docs/contract-recycling-revenue.md §3.2 (D2, D3) — Owner-approved 2026-07-20.
--
-- ── D2: WHY NOT JUST WIDEN geofence_alerts ───────────────────────────────────────────────
-- geofence_alerts is an APPEND-ONLY EVENT LOG. It also carries lifecycle notices
-- (geofence_created / geofence_deleted) and job arrive/leave rows, which are not visits.
-- Money must not be written into it: an immutable log and a mutable financial record have
-- different lifecycles, and a settlement is edited weeks or months after the event it describes.
--
-- Motive makes the visit grain clean: GET /v1/geofences/events returns PAIRED start_time/end_time
-- plus duration, so one API record == one visit. No entry/exit pairing logic is required.
-- (Verified against the live API 2026-07-20: fields id, geofence_id, updated_at, start_time,
-- end_time, duration, vehicle{...}, start_driver, end_driver. There is no event_type field.)
--
-- ── D3: amount IS NULL MEANS OUTSTANDING. ZERO IS REAL. ──────────────────────────────────
-- Owner: "I only enter the amount when I have cash in hand." So amount IS NOT NULL <=> money
-- received, and there is deliberately NO separate `collected` boolean (that column in the
-- owner's sheet is 0 of 2002 populated -- abandoned).
--
-- amount MUST stay nullable with NO default. The owner's history contains a genuine 0 and a
-- genuine -80: "collected nothing" and "the recycler charged me" are real outcomes that must not
-- be confused with "not entered yet". A `numeric DEFAULT 0` would silently mark eight months of
-- history as settled and destroy the outstanding report on day one.
--
-- Additive only. Idempotent.

create table if not exists public.telematics_visits (
  id                    uuid primary key default gen_random_uuid(),
  franchise_id          uuid not null references public.franchises(id) on delete cascade,

  -- Provider identity. provider_event_id is TEXT, not bigint: Motive's id is numeric but Linxup
  -- and future providers may not be, and a text key costs nothing.
  provider              text not null,
  provider_event_id     text not null,
  provider_geofence_id  bigint,                     -- null where a provider omits it (Linxup does)

  -- Resolved facility. NULLABLE BY DESIGN: most visits are job sites, regions, storage or fuel
  -- stops, not configured facilities. Only ~145 of the owner's 2002 historical visits are
  -- recycling. A null here is normal, not a data error.
  facility_id           uuid references public.facilities(id) on delete set null,
  geofence_name         text,                       -- label AS RECORDED AT INGEST; never a key

  vehicle_label         text,                       -- "Truck 3"
  provider_vehicle_id   text,
  vehicle_vin           text,                       -- survives vehicle renames
  driver_name           text,                       -- Motive start_driver/end_driver

  -- Times are UTC. Motive returns an explicit Z suffix (2025-11-07T13:55:15Z), verified live.
  -- NOTE the owner's spreadsheet times are franchise-LOCAL with no zone recorded -- any import
  -- from it must convert via the franchise's officeTimezone (_shared/tz.ts, migrations 0050/0051).
  started_at            timestamptz not null,
  ended_at              timestamptz,
  duration_seconds      integer,                    -- provider-supplied; not recomputed

  -- ── settlement (see D3) ──
  amount                numeric(12,2),              -- NULL = OUTSTANDING. 0 and negatives are real.
  weight_lbs            numeric(12,2),
  settled_at            timestamptz,
  settled_by            uuid references public.profiles(id) on delete set null,
  note                  text,

  source                text not null default 'webhook',
  raw                   jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Makes BOTH the live webhook and the historical backfill idempotent: re-running the import
  -- can never duplicate a visit or overwrite a recorded amount.
  unique (franchise_id, provider, provider_event_id),

  constraint telematics_visits_provider_chk check (provider in ('motive', 'linxup')),
  constraint telematics_visits_source_chk   check (source in ('webhook', 'backfill', 'manual', 'import')),
  constraint telematics_visits_duration_chk check (duration_seconds is null or duration_seconds >= 0),
  -- An amount is only meaningful once it has been recorded by someone.
  constraint telematics_visits_settled_chk  check (amount is null or settled_at is not null)
);

create index if not exists telematics_visits_recent_idx
  on public.telematics_visits (franchise_id, started_at desc);

create index if not exists telematics_visits_facility_idx
  on public.telematics_visits (franchise_id, facility_id, started_at desc);

-- THE outstanding query: unpaid visits, newest first. Partial index so it stays small and fast
-- even as settled history grows without bound.
create index if not exists telematics_visits_outstanding_idx
  on public.telematics_visits (franchise_id, started_at desc)
  where amount is null;

create index if not exists telematics_visits_geofence_idx
  on public.telematics_visits (provider_geofence_id, started_at desc);

drop trigger if exists telematics_visits_touch_updated_at on public.telematics_visits;
create trigger telematics_visits_touch_updated_at
  before update on public.telematics_visits
  for each row execute function public.touch_updated_at();

comment on column public.telematics_visits.amount is
  'Recycling revenue actually COLLECTED. NULL = outstanding (Owner enters only with cash in hand). 0 and negative values are real -- never DEFAULT this.';
comment on column public.telematics_visits.facility_id is
  'NULL is normal: most visits are job sites/regions/storage, not configured facilities.';
