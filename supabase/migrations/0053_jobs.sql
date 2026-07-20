-- 0053_jobs.sql
--
-- The canonical native job entity + its appointments, crew assignment and item locations.
-- Contract: docs/contract-jobs-schema.md §3.1-§3.3, §3.6-§3.8 (Owner-approved 2026-07-19).
--
-- ── D1: JOB AND APPOINTMENT ARE SEPARATE ─────────────────────────────────────────────────
-- One engagement can need multiple visits. BOTH target CRMs model it this way:
--   Vonigo:       Job (jobID) -> WorkOrders. "Copy to another day" = N WorkOrders, one jobID.
--   ServiceTitan: Job -> Appointments. Their Job carries NO time field at all.
-- This is not theoretical: on 2026-06-29 a prod bug cancelled an ENTIRE Vonigo job and all of
-- its appointments because one appointment was cancelled -- the grain error, in production.
-- A flat jobs table with a date column would reproduce that natively and map honestly to
-- neither CRM. Most native jobs will have exactly one appointment; the table exists so the
-- second one is not a migration.
--
-- ── D2: LOCAL WALL-CLOCK, NOT AN INSTANT ─────────────────────────────────────────────────
-- Appointments are agreed as "Tuesday 9am". If a DST boundary falls between booking and
-- service, 9am must STAY 9am -- storing a timestamptz instant makes it silently shift an hour.
-- So: scheduled_date (franchise-local calendar day) + start_minutes (from local midnight).
-- The UTC instant is DERIVED on read via the franchise's IANA zone, which every franchise now
-- carries explicitly (migrations 0050/0051) and _shared/tz.ts resolves. This also converts
-- cleanly both ways: Vonigo wants naive-local (direct), ServiceTitan wants true UTC (derive).
-- start_minutes NULL = day-level scheduling (v1 default per Q-A) -- no fake-midnight sentinel.
--
-- ── D3: status IS WORK LIFECYCLE ONLY ────────────────────────────────────────────────────
-- 'paid' is deliberately NOT a job status. ServiceTitan's invoice has six independent status
-- dimensions and derives paid from balance vs total; Vonigo needs status(181) AND label(201).
-- Conflating work and money means a refund has to mutate work status, and reporting can never
-- separate "done, awaiting payment" from "done, paid". Payment state derives from the future
-- payments table (contract §8).
--
-- Additive only: no existing table is modified. Idempotent via `if not exists`.

-- ─────────────────────────────────────────────────────────────────────────────
-- jobs
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.jobs (
  id                   uuid primary key default gen_random_uuid(),
  franchise_id         uuid not null references public.franchises(id) on delete cascade,
  job_number           text not null,                 -- per-franchise sequence, set by trigger

  customer_id          uuid references public.customers(id) on delete set null,

  -- Denormalized service address (D-Q-S5): the crew's destination is a fact about the JOB,
  -- and customers move. Populated from the customer/location at booking, then owned here.
  service_address      text not null,
  service_city         text,
  service_state        text,
  service_zip          text,
  service_lat          numeric(9,6),
  service_lng          numeric(9,6),

  status               text not null default 'booked',
  origin               text not null default 'manual',

  description          text,
  items_description    text,
  notes_internal       text,                          -- NEVER customer-facing (Vonigo field-200 discipline)

  dwelling_type_id     uuid references public.job_pick_options(id) on delete set null,
  parking_type_id      uuid references public.job_pick_options(id) on delete set null,
  marketing_source_id  uuid references public.marketing_sources(id) on delete set null,

  -- FK targets estimates.id (uuid PK). NOTE: estimates.estimate_id is a SEPARATE nullable
  -- bigint (the app-facing number, e.g. 1781003688449), and estimates.job_id is text holding
  -- the VONIGO job id -- neither is this column. Verified against the live schema 2026-07-19.
  estimate_id          uuid references public.estimates(id) on delete set null,
  estimate_mode        text,                          -- 'full' | 'quick' (Q-F reporting)

  lost_reason_id       uuid references public.job_pick_options(id) on delete set null,
  cancel_reason_id     uuid references public.job_pick_options(id) on delete set null,
  cancel_memo          text,                          -- ServiceTitan cancel needs reasonId AND memo

  created_by           uuid references public.profiles(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (franchise_id, job_number),

  constraint jobs_status_chk check (status in (
    'booked', 'estimating', 'won', 'lost', 'scheduled', 'completed', 'cancelled'
  )),
  constraint jobs_origin_chk check (origin in (
    'manual', 'appointment_center', 'online', 'import'
  )),
  constraint jobs_estimate_mode_chk check (estimate_mode is null or estimate_mode in ('full', 'quick')),
  -- A terminal state must record WHY. Enforced here so no code path can skip it.
  constraint jobs_lost_reason_chk   check (status <> 'lost'      or lost_reason_id   is not null),
  constraint jobs_cancel_reason_chk check (status <> 'cancelled' or cancel_reason_id is not null)
);

create index if not exists jobs_franchise_status_idx  on public.jobs (franchise_id, status);
create index if not exists jobs_franchise_created_idx on public.jobs (franchise_id, created_at desc);
create index if not exists jobs_customer_idx          on public.jobs (customer_id);
create index if not exists jobs_estimate_idx          on public.jobs (estimate_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- job_number — per-franchise sequence
-- ─────────────────────────────────────────────────────────────────────────────
-- Human-facing id crews and customers say out loud. Per-franchise (NOT globally sequential --
-- a global counter leaks total volume across tenants). Q-S1: plain zero-padless integer.
--
-- Counter table + UPDATE ... RETURNING takes a row lock, so concurrent inserts on the same
-- franchise serialize correctly. A max(job_number)+1 trigger would race.
create table if not exists public.franchise_job_counters (
  franchise_id uuid primary key references public.franchises(id) on delete cascade,
  last_number  bigint not null default 1000
);

-- SECURITY DEFINER is load-bearing: 0055 enables RLS on franchise_job_counters with NO policy
-- (it is internal sequence state, not client data). Without DEFINER this trigger would run as
-- the calling user, its counter INSERT/UPDATE would be blocked by RLS, and EVERY client-side
-- job insert would fail. search_path is pinned per the existing current_franchise_id() pattern.
create or replace function public.assign_job_number()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n bigint;
begin
  if new.job_number is not null and new.job_number <> '' then
    return new;                       -- caller supplied one (e.g. an import); respect it
  end if;

  insert into public.franchise_job_counters (franchise_id)
  values (new.franchise_id)
  on conflict (franchise_id) do nothing;

  update public.franchise_job_counters
     set last_number = last_number + 1
   where franchise_id = new.franchise_id
  returning last_number into n;

  new.job_number := n::text;
  return new;
end;
$$;

drop trigger if exists jobs_assign_job_number on public.jobs;
create trigger jobs_assign_job_number
  before insert on public.jobs
  for each row execute function public.assign_job_number();

-- updated_at maintenance
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists jobs_touch_updated_at on public.jobs;
create trigger jobs_touch_updated_at
  before update on public.jobs
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- job_appointments — the scheduled visits
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.job_appointments (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null references public.jobs(id) on delete cascade,
  franchise_id      uuid not null references public.franchises(id) on delete cascade,  -- denormalized for RLS + index

  scheduled_date    date not null,                    -- franchise-LOCAL calendar day (D2)
  start_minutes     int,                              -- from franchise-local midnight; NULL = day-level
  duration_minutes  int,                              -- NULL = job-type default
  sequence          int not null default 0,           -- order within the day / route

  route_id          uuid references public.routes(id) on delete set null,  -- NULL for ServiceTitan (no route entity)
  status            text not null default 'scheduled',

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint job_appointments_status_chk check (status in (
    'scheduled', 'dispatched', 'working', 'done', 'cancelled'
  )),
  constraint job_appointments_start_chk    check (start_minutes is null or (start_minutes >= 0 and start_minutes <= 1439)),
  constraint job_appointments_duration_chk check (duration_minutes is null or duration_minutes > 0)
);

-- THE board query: "every appointment for this franchise on this day".
create index if not exists job_appointments_board_idx
  on public.job_appointments (franchise_id, scheduled_date, sequence);
create index if not exists job_appointments_job_idx   on public.job_appointments (job_id);
create index if not exists job_appointments_route_idx on public.job_appointments (route_id, scheduled_date);

drop trigger if exists job_appointments_touch_updated_at on public.job_appointments;
create trigger job_appointments_touch_updated_at
  before update on public.job_appointments
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- job_crew — crew attaches to the VISIT, not the job
-- ─────────────────────────────────────────────────────────────────────────────
-- Different visits can carry different crews (matches ServiceTitan Assignments and reality).
-- profile_id, not crew_members: crew get their own login (Q-C, decided 2026-07-12).
create table if not exists public.job_crew (
  id              uuid primary key default gen_random_uuid(),
  appointment_id  uuid not null references public.job_appointments(id) on delete cascade,
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  role            text,
  created_at      timestamptz not null default now(),
  unique (appointment_id, profile_id),
  constraint job_crew_role_chk check (role is null or role in ('lead', 'helper'))
);

create index if not exists job_crew_profile_idx on public.job_crew (profile_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- job_item_locations — many locations per job (D4: join table, not text[])
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.job_item_locations (
  job_id     uuid not null references public.jobs(id) on delete cascade,
  option_id  uuid not null references public.job_pick_options(id) on delete cascade,
  primary key (job_id, option_id)
);
