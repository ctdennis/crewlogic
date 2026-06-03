-- 0006: Phase 3 / SEC-1 (CL-SPEC-004) — scope-resolver helpers.
-- Additive + re-runnable. ZERO app impact until RLS policies reference them.
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0006_rls_scope_helpers.sql
-- Apply to prod (at promotion, gated):  supabase db query --linked -f <this file>  (linked to prod)
--
-- These resolve the requesting user's scope from auth.uid() -> profiles -> franchise/tenant.
-- SECURITY DEFINER + fixed search_path so they read profiles regardless of (future) RLS on profiles,
-- which avoids recursive-policy evaluation. They return NULL outside an authenticated context
-- (e.g. anon, or the service role), which scoped policies treat as "matches nothing".
-- NOTE: not named current_role() — that's a reserved Postgres function.

create or replace function public.current_franchise_id()
returns uuid language sql stable security definer set search_path = public as $$
  select franchise_id from public.profiles where auth_user_id = auth.uid() limit 1
$$;

create or replace function public.current_tenant_id()
returns uuid language sql stable security definer set search_path = public as $$
  select f.tenant_id
  from public.profiles p
  join public.franchises f on f.id = p.franchise_id
  where p.auth_user_id = auth.uid()
  limit 1
$$;

create or replace function public.current_user_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where auth_user_id = auth.uid() limit 1
$$;

-- Callable by logged-in users (and harmlessly by anon → NULL). Lock out PUBLIC default first.
revoke all on function public.current_franchise_id() from public;
revoke all on function public.current_tenant_id()   from public;
revoke all on function public.current_user_role()    from public;
grant execute on function public.current_franchise_id() to authenticated, anon;
grant execute on function public.current_tenant_id()   to authenticated, anon;
grant execute on function public.current_user_role()    to authenticated, anon;
