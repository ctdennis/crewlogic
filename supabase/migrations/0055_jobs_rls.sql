-- 0055_jobs_rls.sql
--
-- Row-level security for the native jobs tables.
-- Contract: docs/contract-jobs-schema.md §3.9
--
-- ── WHY THIS IS NOT OPTIONAL ─────────────────────────────────────────────────────────────
-- A new Postgres table has RLS DISABLED by default, and Supabase exposes public-schema tables
-- through PostgREST. Until these policies exist, anyone holding the (publishable, client-side)
-- anon key could read or write every franchise's jobs. Shipped in the same batch as the tables
-- for that reason -- never a follow-up.
--
-- ── FAIL CLOSED ──────────────────────────────────────────────────────────────────────────
-- Every policy compares franchise_id to public.current_franchise_id(), which resolves the
-- caller's franchise from their profile. If it returns NULL (no profile, unauthenticated,
-- mismatched email) the comparison is NULL -> NOT TRUE -> ZERO ROWS. It must never fall open.
-- Precedent: the 2026-07-07 Live Alerts hardening, where a CLIENT-side franchise check was
-- bypassed whenever franchiseInternalID happened to be falsy. Server-side and fail-closed.
--
-- The service role bypasses RLS entirely, so edge functions using SUPABASE_SERVICE_ROLE_KEY
-- are unaffected by these policies -- they enforce their own scoping.
--
-- Crew visibility (Q-J, decided 2026-07-12) is deliberately NOT implemented here: the
-- profiles.visibility_scope column does not exist yet. Until it does, crew read access is the
-- same franchise-wide SELECT as office roles. Narrowing it to own_route is a follow-up
-- migration -- and narrowing later is safe, because it only ever removes access.
--
-- Idempotent: policies are dropped before create.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enable RLS
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.jobs                    enable row level security;
alter table public.job_appointments        enable row level security;
alter table public.job_crew                enable row level security;
alter table public.job_item_locations      enable row level security;
alter table public.external_refs           enable row level security;
alter table public.marketing_sources       enable row level security;
alter table public.job_pick_options        enable row level security;
alter table public.routes                  enable row level security;
alter table public.franchise_job_counters  enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- jobs
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists jobs_franchise_all on public.jobs;
create policy jobs_franchise_all on public.jobs
  for all
  using      (franchise_id = public.current_franchise_id())
  with check (franchise_id = public.current_franchise_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- job_appointments — franchise_id is denormalized onto the row precisely so this
-- policy needs no join back to jobs.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists job_appointments_franchise_all on public.job_appointments;
create policy job_appointments_franchise_all on public.job_appointments
  for all
  using      (franchise_id = public.current_franchise_id())
  with check (franchise_id = public.current_franchise_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- job_crew — no franchise_id of its own; scoped through its appointment.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists job_crew_franchise_all on public.job_crew;
create policy job_crew_franchise_all on public.job_crew
  for all
  using (exists (
    select 1 from public.job_appointments a
     where a.id = job_crew.appointment_id
       and a.franchise_id = public.current_franchise_id()
  ))
  with check (exists (
    select 1 from public.job_appointments a
     where a.id = job_crew.appointment_id
       and a.franchise_id = public.current_franchise_id()
  ));

-- ─────────────────────────────────────────────────────────────────────────────
-- job_item_locations — scoped through its job.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists job_item_locations_franchise_all on public.job_item_locations;
create policy job_item_locations_franchise_all on public.job_item_locations
  for all
  using (exists (
    select 1 from public.jobs j
     where j.id = job_item_locations.job_id
       and j.franchise_id = public.current_franchise_id()
  ))
  with check (exists (
    select 1 from public.jobs j
     where j.id = job_item_locations.job_id
       and j.franchise_id = public.current_franchise_id()
  ));

-- ─────────────────────────────────────────────────────────────────────────────
-- external_refs — carries franchise_id directly.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists external_refs_franchise_all on public.external_refs;
create policy external_refs_franchise_all on public.external_refs
  for all
  using      (franchise_id = public.current_franchise_id())
  with check (franchise_id = public.current_franchise_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- Reference data — readable by the franchise; writes go through the service role
-- (settings screens), so no client-side INSERT/UPDATE policy is granted.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists marketing_sources_franchise_sel on public.marketing_sources;
create policy marketing_sources_franchise_sel on public.marketing_sources
  for select using (franchise_id = public.current_franchise_id());

drop policy if exists job_pick_options_franchise_sel on public.job_pick_options;
create policy job_pick_options_franchise_sel on public.job_pick_options
  for select using (franchise_id = public.current_franchise_id());

drop policy if exists routes_franchise_sel on public.routes;
create policy routes_franchise_sel on public.routes
  for select using (franchise_id = public.current_franchise_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- franchise_job_counters — internal sequence state. No client access at all;
-- RLS is enabled with NO policy, so only the service role (and the SECURITY DEFINER
-- trigger) can touch it.
-- ─────────────────────────────────────────────────────────────────────────────
