-- 0014: allow guest-tester invite links to be created.
--
-- Bug: "Generate" guest invite link (generateGuestInviteLink) inserts an invite
-- with franchise_id = NULL (a guest invite — no franchise, role 'owner', the
-- holder self-provisions a new tenant on accept). The original invites_insert
-- policy's WITH CHECK was `franchise_id = current_franchise_id()`, and
-- `NULL = current_franchise_id()` is never true → every guest-invite insert was
-- rejected with 403 Forbidden (prod, Set up / Account screen).
--
-- Fix: keep the franchise-scoped path, AND also permit a NULL-franchise invite
-- when the inserter is a real provisioned user (current_franchise_id() IS NOT
-- NULL). Anonymous callers still resolve to NULL franchise → both clauses false
-- → still blocked.
--
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0014_invites_allow_guest_invite.sql
-- Apply to prod: gated (supabase db push / dashboard) — see approval discipline.

drop policy if exists invites_insert on public.invites;

create policy invites_insert on public.invites
  for insert to authenticated
  with check (
    franchise_id = public.current_franchise_id()
    or (franchise_id is null and public.current_franchise_id() is not null)
  );
