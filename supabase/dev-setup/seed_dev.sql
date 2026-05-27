-- Dev seed data for crewlogic-dev. Idempotent (re-runnable).
-- Synthetic standalone tenant (crm_type='none') + owner + two estimates used to
-- test the estimate discard/hard-delete fix. Matches the "🔧 Dev sign-in" identity
-- in index.html (devSignIn): email dev-owner@crewlogic.test / external_id DEV1.
-- Apply (linked to dev): supabase db query --linked -f supabase/dev-setup/seed_dev.sql

-- Clean any prior seed (vonigo_credentials first to satisfy the FK; NOTE: re-seeding
-- wipes any Vonigo creds you entered in dev Settings — re-enter them after a re-seed).
delete from public.vonigo_credentials where franchise_id in ('22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444');
delete from public.estimates  where owner_email in ('dev-owner@crewlogic.test', 'dev-vonigo@crewlogic.test');
delete from public.profiles   where email in ('dev-owner@crewlogic.test', 'dev-vonigo@crewlogic.test');
delete from public.franchises where id in ('22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444');
delete from public.tenants    where id in ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333');

insert into public.tenants (id, slug, name, crm_type, subscription_status)
values ('11111111-1111-1111-1111-111111111111', 'dev-standalone', 'Dev Standalone Co', 'none', 'trialing');

insert into public.franchises (id, tenant_id, external_id, franchise_name, subscription_tier, vonigo_configured)
values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'DEV1', 'Dev Standalone Co', 'tester', false);

insert into public.profiles (franchise_id, email, name, role)
values ('22222222-2222-2222-2222-222222222222', 'dev-owner@crewlogic.test', 'Dev Owner', 'owner');

-- Vonigo-provider test tenant: external_id '90' so entered creds authenticate as franchise #90
-- and reads return real #90 data. Writes are blocked server-side (VONIGO_READONLY on dev).
-- Sign in via "🔧 Dev sign-in · Vonigo #90", then Settings → enter the #90 Vonigo credentials.
insert into public.tenants (id, slug, name, crm_type, subscription_status)
values ('33333333-3333-3333-3333-333333333333', 'dev-vonigo', 'Dev Vonigo (90)', 'vonigo', 'trialing');

insert into public.franchises (id, tenant_id, external_id, franchise_name, subscription_tier, vonigo_configured)
values ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', '90', 'Dev Vonigo (90)', 'tester', false);

insert into public.profiles (franchise_id, email, name, role)
values ('44444444-4444-4444-4444-444444444444', 'dev-vonigo@crewlogic.test', 'Dev Vonigo Owner', 'owner');

-- (1) Healthy won estimate WITH charges — control: must open + exit normally, never auto-discard.
-- job_id set so openEstimateEditor shows #estMainContent (charges visible) without a price lookup.
insert into public.estimates
  (estimate_id, franchise_id, owner_email, label, status, client_name, address, zip, total_price, total_trucks, job_id, payload)
values
  (9000000000001, '22222222-2222-2222-2222-222222222222', 'dev-owner@crewlogic.test',
   'Healthy Won — has charges', 'won', 'Smith, John', '123 Main St, Columbus OH 43215', '43215', 850, 1.5, 'DEV-1001',
   '{"charges":[{"type":"volume","room":"Garage","area":"Garage","truckLabel":"1/2","truckQty":1,"pctRecycled":0,"pctDonated":0,"description":"Misc junk and boxes","notIncluded":"","photos":["data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==","photo_9000000000001_unassigned_1_0"]},{"type":"surcharge","name":"Stairs surcharge","qty":1,"unitPrice":50,"description":"2nd-floor carry","area":"","photos":[]}],"notes":"Access via side door — volume charge has 3 demo photos: green(path)/yellow(base64)/red(orphan photoID)"}'::jsonb);

-- (2) Bug-repro won estimate with EMPTY payload — charges load empty in memory.
-- job_id + total_price>0 make openEstimateEditor open the editor with an EMPTY charge list
-- (faithfully reproducing the incident), rather than the job picker.
-- Pre-fix: backing out hard-deletes this row. Post-fix: it must survive (silent exit / soft-delete only).
insert into public.estimates
  (estimate_id, franchise_id, owner_email, label, status, client_name, address, zip, total_price, total_trucks, job_id, payload)
values
  (9000000000002, '22222222-2222-2222-2222-222222222222', 'dev-owner@crewlogic.test',
   'Bug Repro Won — empty charges', 'won', 'Doe, Jane', '456 Oak Ave, Columbus OH 43215', '43215', 1200, 2, 'DEV-1002',
   '{}'::jsonb);

-- (3) DRAFT estimate for photo-capture testing. status='draft' so autosave persists;
-- job_id + a charge so it opens straight into the editor (no Vonigo lookup needed in dev).
insert into public.estimates
  (estimate_id, franchise_id, owner_email, label, status, client_name, address, zip, total_price, total_trucks, job_id, payload)
values
  (9000000000003, '22222222-2222-2222-2222-222222222222', 'dev-owner@crewlogic.test',
   'Photo Test — DRAFT', 'draft', 'Test, Photo', '789 Test Rd, Columbus OH 43215', '43215', 0, 1, 'DEV-1003',
   '{"charges":[{"type":"volume","room":"Garage","area":"Garage","truckLabel":"1/4","truckQty":1,"pctRecycled":0,"pctDonated":0,"description":"Add photos here to test sync persistence","notIncluded":"","photos":[]}],"notes":"Draft for photo-sync testing"}'::jsonb);
