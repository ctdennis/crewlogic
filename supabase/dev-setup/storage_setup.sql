-- Dev Storage setup: create the estimate-photos bucket + anon RLS policies, mirroring
-- prod, so photo upload / signed-URL / delete work in dev. Idempotent.
-- Apply (linked to DEV): supabase db query --linked -f supabase/dev-setup/storage_setup.sql

insert into storage.buckets (id, name, public)
values ('estimate-photos', 'estimate-photos', false)
on conflict (id) do nothing;

drop policy if exists "allow read estimate photos"   on storage.objects;
drop policy if exists "allow upload estimate photos" on storage.objects;
drop policy if exists "allow delete estimate photos" on storage.objects;

create policy "allow read estimate photos"   on storage.objects for select to anon using (bucket_id = 'estimate-photos');
create policy "allow upload estimate photos" on storage.objects for insert to anon with check (bucket_id = 'estimate-photos');
create policy "allow delete estimate photos" on storage.objects for delete to anon using (bucket_id = 'estimate-photos');
