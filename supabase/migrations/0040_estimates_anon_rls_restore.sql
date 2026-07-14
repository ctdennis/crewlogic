-- 0040_estimates_anon_rls_restore.sql
-- Restore estimates read/write for the Google / dev-signin path.
--
-- Root cause (owner-reported 2026-07-14): the estimates list showed "your session may have expired"
-- for owners while all Vonigo data loaded. estimates RLS is ENABLED and its four policies (SEC-1,
-- estimates_sel/ins/upd/del) apply ONLY to role `authenticated` and gate on current_franchise_id()
-- (= profiles row for auth.uid()). But EVERY owner signs in with Google (custom session → the app
-- falls back to the anon key, no auth.uid()); the dev sign-in does the same. With RLS on and NO
-- policy for the `anon` role, PostgREST denies by default → every estimates read/update/delete
-- returns empty → the app reads that as an expired session. Vonigo data is unaffected because it
-- flows through edge functions (service role / --no-verify-jwt), never PostgREST RLS.
--
-- This adds permissive `anon` policies so the anon/Google path works again (the state index.html's
-- _supabaseUserToken() comment already assumes — "No-op while policies remain wide-open"). The
-- existing `authenticated` scoped policies are left untouched for native/magic-link users.
--
-- SECURITY NOTE + FOLLOW-UP: this restores the pre-SEC-1 posture where the public anon key can read
-- estimates. The proper re-hardening is to give the Google sign-in a verifiable identity (a real
-- Supabase JWT, or route estimate reads through an edge function that authorizes the caller), then
-- drop these permissive anon policies and rely on the scoped `authenticated` ones. Tracked as a
-- follow-up.
--
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0040_estimates_anon_rls_restore.sql
-- Apply to prod (gated): supabase db query --linked -f supabase/migrations/0040_estimates_anon_rls_restore.sql  (linked to prod)

-- anon needs the table grants too (RLS is the gate, but the role must also be granted).
grant select, insert, update, delete on public.estimates to anon;

drop policy if exists estimates_sel_anon on public.estimates;
create policy estimates_sel_anon on public.estimates for select to anon using (true);

drop policy if exists estimates_ins_anon on public.estimates;
create policy estimates_ins_anon on public.estimates for insert to anon with check (true);

drop policy if exists estimates_upd_anon on public.estimates;
create policy estimates_upd_anon on public.estimates for update to anon using (true) with check (true);

drop policy if exists estimates_del_anon on public.estimates;
create policy estimates_del_anon on public.estimates for delete to anon using (true);

-- ROLLBACK (manual):
--   drop policy if exists estimates_sel_anon on public.estimates;
--   drop policy if exists estimates_ins_anon on public.estimates;
--   drop policy if exists estimates_upd_anon on public.estimates;
--   drop policy if exists estimates_del_anon on public.estimates;
--   -- (leave the grant; it is harmless without a permissive policy — RLS still gates)
