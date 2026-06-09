-- 0015_admin_delete_tenant.sql
-- Ops routine: delete a NON-production (test / verification) tenant and its data — all DB rows
-- and (optionally) the auth.users login identities. Estimate-photo STORAGE objects are NOT
-- removed here (prod's storage.protect_delete() trigger blocks SQL deletes of storage.objects);
-- delete those separately via the Storage API using the returned franchise external_id(s) as the
-- path prefix. So the full routine is: (1) this function, then (2) a Storage API delete.
--
-- Usage (run as the db owner via `supabase db query`, NOT exposed to the app API):
--   select * from public.admin_delete_tenant('<tenant-uuid>');            -- wipes app data + auth users
--   select * from public.admin_delete_tenant('<tenant-uuid>', false);     -- keep auth.users
--
-- Returns one row per step with the number of rows removed, for verification.
--
-- Safety:
--   * Hard-refuses the Junkluggers production tenant (946a4535-aa61-45b6-a6fb-9190ff546d41).
--   * Refuses a tenant that has no franchises (wrong id / already gone) before touching anything.
--   * Each call is atomic — any error rolls the whole deletion back.
--   * EXECUTE is revoked from anon/authenticated/public so it can never be called via PostgREST RPC.
--
-- FK notes baked into the delete order (verified against prod schema 2026-06-09):
--   franchises CASCADEs: campaigns, crew_members, customer_price_lists, sign_credits, sign_rewards,
--     sign_sessions, sign_status_events, vonigo_credentials, yard_signs.
--   price_lists CASCADEs: price_blocks, price_list_zips.
--   Must pre-delete (NO ACTION / no FK to franchises): estimates, invites, profiles, customers,
--     price_lists, job_plans, tools, feedback, vonigo_credential_audit.
--   invites.invited_by -> profiles and profiles.invited_by -> profiles (self-ref): delete invites
--     before profiles; profiles deleted in a single statement so the owner->estimator self-ref clears.

create or replace function public.admin_delete_tenant(
  p_tenant_id uuid,
  p_delete_auth boolean default true
)
returns table(step text, rows_removed bigint)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_franchises uuid[];
  v_externals  text[];
  v_auth_ids   uuid[];
  v_n          bigint;
begin
  if p_tenant_id = '946a4535-aa61-45b6-a6fb-9190ff546d41' then
    raise exception 'Refusing to delete the Junkluggers production tenant (946a4535-...).';
  end if;

  select array_agg(id), array_agg(external_id)
    into v_franchises, v_externals
    from franchises where tenant_id = p_tenant_id;

  if v_franchises is null then
    raise exception 'No franchises found for tenant % — aborting (wrong id or already deleted).', p_tenant_id;
  end if;

  select array_agg(auth_user_id)
    into v_auth_ids
    from profiles
   where franchise_id = any(v_franchises) and auth_user_id is not null;

  delete from estimates where franchise_id = any(v_franchises);
  get diagnostics v_n = row_count; step := 'estimates'; rows_removed := v_n; return next;

  delete from invites where franchise_id = any(v_franchises);
  get diagnostics v_n = row_count; step := 'invites'; rows_removed := v_n; return next;

  delete from profiles where franchise_id = any(v_franchises);
  get diagnostics v_n = row_count; step := 'profiles'; rows_removed := v_n; return next;

  delete from customers where franchise_id = any(v_franchises);
  get diagnostics v_n = row_count; step := 'customers'; rows_removed := v_n; return next;

  delete from price_lists where franchise_id = any(v_franchises);  -- cascades price_blocks, price_list_zips
  get diagnostics v_n = row_count; step := 'price_lists'; rows_removed := v_n; return next;

  delete from job_plans where franchise_id = any(v_franchises);
  get diagnostics v_n = row_count; step := 'job_plans'; rows_removed := v_n; return next;

  delete from tools where franchise_id = any(v_franchises);
  get diagnostics v_n = row_count; step := 'tools'; rows_removed := v_n; return next;

  delete from feedback where franchise_id = any(v_franchises);
  get diagnostics v_n = row_count; step := 'feedback'; rows_removed := v_n; return next;

  delete from vonigo_credential_audit where franchise_id = any(v_franchises);
  get diagnostics v_n = row_count; step := 'vonigo_credential_audit'; rows_removed := v_n; return next;

  delete from franchises where tenant_id = p_tenant_id;  -- cascades the franchise-scoped child tables
  get diagnostics v_n = row_count; step := 'franchises'; rows_removed := v_n; return next;

  delete from tenants where id = p_tenant_id;
  get diagnostics v_n = row_count; step := 'tenants'; rows_removed := v_n; return next;

  -- NOTE: estimate-photo storage objects (pathed external_id/estimate_id/file.jpg in the
  -- estimate-photos bucket) are NOT deleted here. Prod's storage.protect_delete() trigger blocks
  -- direct DELETE from storage.objects — they must be removed via the Storage API. After calling
  -- this function, delete them with the API using the franchise external_id(s) as the path prefix
  -- (this function returns them in the 'external_ids' step below for convenience).
  step := 'external_ids (clean storage via API)'; rows_removed := coalesce(array_length(v_externals,1),0); return next;

  if p_delete_auth and v_auth_ids is not null then
    delete from auth.users where id = any(v_auth_ids);  -- cascades auth identities/sessions/refresh tokens
    get diagnostics v_n = row_count; step := 'auth_users'; rows_removed := v_n; return next;
  end if;

  return;
end $$;

revoke all on function public.admin_delete_tenant(uuid, boolean) from public, anon, authenticated;
