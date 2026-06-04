-- 0011: estimate-photos storage — grant the `authenticated` role the same access as `anon`.
--
-- The estimate-photos bucket is private; its three RLS policies were authored in the anon-only era
-- (Google custom-session users + the hardcoded anon key). Native/magic-link users now carry a real
-- Supabase Auth session, so their Storage requests arrive as role `authenticated` — which NO policy
-- grants. Result: createSignedUrl / upload return HTTP 400 and logged-in users see broken cover
-- photos (the failure mode already noted in index.html:4323). The session-less anon `storageClient`
-- workaround does not reliably hold, so fix it at the source: widen each policy to cover both roles.
--
-- This matches the wide-open spirit of the existing anon policies (bucket-scoped only). Per-franchise
-- path scoping can be layered on later alongside the broader RLS tightening (0006–0010).
--
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0011_storage_authenticated_estimate_photos.sql
-- Apply to prod: gated (storage-policy write) — promote after dev verification.

drop policy if exists "allow read estimate photos"   on storage.objects;
drop policy if exists "allow upload estimate photos" on storage.objects;
drop policy if exists "allow delete estimate photos" on storage.objects;

create policy "allow read estimate photos"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'estimate-photos');

create policy "allow upload estimate photos"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'estimate-photos');

create policy "allow delete estimate photos"
  on storage.objects for delete
  to anon, authenticated
  using (bucket_id = 'estimate-photos');
