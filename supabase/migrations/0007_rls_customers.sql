-- 0007: SEC-1 (CL-SPEC-004) — franchise-scoped policies for `customers`. The proven template
-- for the table-by-table rollout.
--
-- ⚠️ NOT YET APPLIED to dev or prod. The rollout is gated on the dev test-session approach:
-- the dev sign-in BYPASS sets currentUser without a Supabase Auth session, so it has no auth.uid()
-- and would see zero customers under these policies. Resolve that first (CL-SPEC-004 §10/§12) so we
-- can verify in-browser, then apply table-by-table. Pattern already verified 2026-06-03 via a
-- rolled-back impersonation test (authed user saw only its own franchise's rows, none of another's).
--
-- Apply (dev, when ready):  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0007_rls_customers.sql

alter table public.customers enable row level security;  -- idempotent (already enabled)

-- Replace the wide-open Stage A policy with per-command, franchise-scoped policies.
drop policy if exists "stage_a customers all" on public.customers;

create policy customers_select on public.customers for select to authenticated
  using (franchise_id = public.current_franchise_id());

create policy customers_insert on public.customers for insert to authenticated
  with check (franchise_id = public.current_franchise_id());

create policy customers_update on public.customers for update to authenticated
  using (franchise_id = public.current_franchise_id())
  with check (franchise_id = public.current_franchise_id());

create policy customers_delete on public.customers for delete to authenticated
  using (franchise_id = public.current_franchise_id());

-- Note: no `anon` policy → customers are not reachable without an authenticated session (intended).
