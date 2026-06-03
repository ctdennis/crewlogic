-- 0010: SEC-1 (CL-SPEC-004) — scope the identity/bootstrap tables: profiles, franchises, tenants.
-- These are read during login/session-build, including the FIRST login before crewlogic-link-identity
-- has linked auth_user_id. So the scope helpers fall back to the JWT email (auth.email()), letting a
-- user read their own profile/franchise/tenant pre-link. Verified via rolled-back dry-run 2026-06-03.
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0010_rls_identity_tables.sql
-- Apply to prod: gated, at the coordinated cutover (after backfilling unlinked owners).

-- Helpers: resolve by auth.uid() OR (pre-link fallback) the JWT email. SECURITY DEFINER → bypass RLS
-- on profiles (no recursion). Prefer the uid match when both exist.
create or replace function public.current_franchise_id()
returns uuid language sql stable security definer set search_path = public as $$
  select franchise_id from public.profiles
  where auth_user_id = auth.uid() or lower(email) = lower(auth.email())
  order by (auth_user_id = auth.uid()) desc nulls last limit 1
$$;
create or replace function public.current_tenant_id()
returns uuid language sql stable security definer set search_path = public as $$
  select f.tenant_id from public.profiles p join public.franchises f on f.id = p.franchise_id
  where p.auth_user_id = auth.uid() or lower(p.email) = lower(auth.email())
  order by (p.auth_user_id = auth.uid()) desc nulls last limit 1
$$;
create or replace function public.current_user_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles
  where auth_user_id = auth.uid() or lower(email) = lower(auth.email())
  order by (auth_user_id = auth.uid()) desc nulls last limit 1
$$;

-- Drop existing (open) policies on the three tables.
do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('profiles','franchises','tenants') loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- profiles: read own (by uid or JWT email) + franchise-mates (team list); update own.
-- INSERT/DELETE stay service-role-only (provisioning + team mgmt via edge fns) — no client policy.
alter table public.profiles enable row level security;
create policy profiles_select on public.profiles for select to authenticated
  using (auth_user_id = auth.uid() or lower(email) = lower(auth.email()) or franchise_id = public.current_franchise_id());
create policy profiles_update on public.profiles for update to authenticated
  using (auth_user_id = auth.uid() or lower(email) = lower(auth.email()))
  with check (auth_user_id = auth.uid() or lower(email) = lower(auth.email()));

-- franchises: own franchise only (writes also go via the crewlogic-settings edge fn / service role).
alter table public.franchises enable row level security;
create policy franchises_select on public.franchises for select to authenticated
  using (id = public.current_franchise_id());
create policy franchises_update on public.franchises for update to authenticated
  using (id = public.current_franchise_id()) with check (id = public.current_franchise_id());

-- tenants: own tenant, read-only for clients.
alter table public.tenants enable row level security;
create policy tenants_select on public.tenants for select to authenticated
  using (id = public.current_tenant_id());
