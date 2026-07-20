-- 0058_telematics_visits_rls.sql
--
-- Row-level security for telematics_visits.
-- Contract: docs/contract-recycling-revenue.md §3.2
--
-- SHIPPED IN THE SAME BATCH AS THE TABLE, deliberately. A new Postgres table has RLS DISABLED by
-- default and Supabase exposes public-schema tables through PostgREST, so any gap between creating
-- this table and policing it is a window in which the publishable anon key can read or write every
-- franchise's visit history -- which now includes revenue figures.
--
-- FAIL CLOSED: policies compare franchise_id to public.current_franchise_id(). If that returns NULL
-- (no profile, unauthenticated, mismatched email) the comparison is NULL -> NOT TRUE -> ZERO ROWS.
-- Precedent: the 2026-07-07 Live Alerts hardening, where a CLIENT-side franchise check was bypassed
-- whenever franchiseInternalID happened to be falsy.
--
-- The service role bypasses RLS entirely, so the webhook receiver and the backfill importer are
-- unaffected -- they enforce their own franchise scoping.
--
-- Idempotent.

alter table public.telematics_visits enable row level security;

drop policy if exists telematics_visits_franchise_all on public.telematics_visits;
create policy telematics_visits_franchise_all on public.telematics_visits
  for all
  using      (franchise_id = public.current_franchise_id())
  with check (franchise_id = public.current_franchise_id());

-- NOTE ON CREW ACCESS: crew members get their own logins (contract-jobs-schema.md Q-C) and this
-- policy currently grants them the same franchise-wide access as office roles, INCLUDING the
-- revenue columns. profiles.visibility_scope does not exist yet; once it does, crew should be
-- narrowed -- and revenue is a stronger argument for narrowing than job visibility was. Tightening
-- later only ever removes access, so it is safe to defer, but it should not be forgotten.
