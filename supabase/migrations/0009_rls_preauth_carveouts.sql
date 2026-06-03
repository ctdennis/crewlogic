-- 0009: SEC-1 (CL-SPEC-004) — pre-auth carve-outs for `invites` and `feedback`.
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0009_rls_preauth_carveouts.sql
-- Apply to prod: gated, at promotion (with the Google->Supabase Auth cutover).
--
-- vonigo_credentials / vonigo_credential_audit: RLS is enabled with ZERO policies = deny-all to
-- anon/authenticated (service-role/edge-fn only). That is the desired lockdown — intentionally no
-- policy is added here.

-- invites: the token is a bearer secret used BEFORE the user has any auth identity (invite accept,
-- OAuth callback). RLS can't see the `token=eq.` filter, so SELECT stays open (knowing the token is the
-- access control). Writes are locked: only logged-in owners create/manage invites for their own
-- franchise; acceptance writes go through edge functions (service role, RLS-exempt).
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname='public' and tablename='invites' loop
    execute format('drop policy if exists %I on public.invites', r.policyname);
  end loop;
end $$;
create policy invites_read   on public.invites for select to anon, authenticated using (true);
create policy invites_insert on public.invites for insert to authenticated with check (franchise_id = public.current_franchise_id());
create policy invites_update on public.invites for update to authenticated using (franchise_id = public.current_franchise_id()) with check (franchise_id = public.current_franchise_id());
create policy invites_delete on public.invites for delete to authenticated using (franchise_id = public.current_franchise_id());

-- feedback: anyone may submit; reads restricted to the submitter's own franchise (was world-readable).
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname='public' and tablename='feedback' loop
    execute format('drop policy if exists %I on public.feedback', r.policyname);
  end loop;
end $$;
create policy feedback_insert on public.feedback for insert to anon, authenticated with check (true);
create policy feedback_read   on public.feedback for select to authenticated using (franchise_id = public.current_franchise_id());
