-- Dev seed data for crewlogic-dev. Idempotent (re-runnable).
-- Synthetic standalone tenant (crm_type='none') + owner + two estimates used to
-- test the estimate discard/hard-delete fix. Matches the "🔧 Dev sign-in" identity
-- in index.html (devSignIn): email dev-owner@crewlogic.test / external_id DEV1.
-- Apply (linked to dev): supabase db query --linked -f supabase/dev-setup/seed_dev.sql

-- Clean any prior seed
delete from public.estimates  where owner_email = 'dev-owner@crewlogic.test';
delete from public.profiles   where email = 'dev-owner@crewlogic.test';
delete from public.franchises where id = '22222222-2222-2222-2222-222222222222';
delete from public.tenants    where id = '11111111-1111-1111-1111-111111111111';

insert into public.tenants (id, slug, name, crm_type, subscription_status)
values ('11111111-1111-1111-1111-111111111111', 'dev-standalone', 'Dev Standalone Co', 'none', 'trialing');

insert into public.franchises (id, tenant_id, external_id, franchise_name, subscription_tier, vonigo_configured)
values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'DEV1', 'Dev Standalone Co', 'tester', false);

insert into public.profiles (franchise_id, email, name, role)
values ('22222222-2222-2222-2222-222222222222', 'dev-owner@crewlogic.test', 'Dev Owner', 'owner');

-- (1) Healthy won estimate WITH charges — control: must open + exit normally, never auto-discard.
insert into public.estimates
  (estimate_id, franchise_id, owner_email, label, status, client_name, address, zip, total_price, total_trucks, payload)
values
  (9000000000001, '22222222-2222-2222-2222-222222222222', 'dev-owner@crewlogic.test',
   'Healthy Won — has charges', 'won', 'Smith, John', '123 Main St, Columbus OH 43215', '43215', 850, 1.5,
   '{"charges":[{"type":"volume","room":"Garage","area":"Garage","truckLabel":"1/2","truckQty":1,"pctRecycled":0,"pctDonated":0,"description":"Misc junk and boxes","notIncluded":"","photos":[]},{"type":"surcharge","name":"Stairs surcharge","qty":1,"unitPrice":50,"description":"2nd-floor carry","area":"","photos":[]}],"notes":"Access via side door"}'::jsonb);

-- (2) Bug-repro won estimate with EMPTY payload — charges load empty in memory.
-- Pre-fix: backing out hard-deletes this row. Post-fix: it must survive (silent exit / soft-delete only).
insert into public.estimates
  (estimate_id, franchise_id, owner_email, label, status, client_name, address, zip, total_price, total_trucks, payload)
values
  (9000000000002, '22222222-2222-2222-2222-222222222222', 'dev-owner@crewlogic.test',
   'Bug Repro Won — empty charges', 'won', 'Doe, Jane', '456 Oak Ave, Columbus OH 43215', '43215', 1200, 2,
   '{}'::jsonb);
