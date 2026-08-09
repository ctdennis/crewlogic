-- Manual "out of service" flag per truck (owner-set in Settings → Trucks).
-- A disabled truck is treated as UNUSABLE: hidden from the trucks map/list and the board's
-- assignment roster, and excluded from geofence auto-assign. It still appears in Truck Setup
-- (so it can be re-enabled). Distinct from `active` (which tracks telematics-feed presence).
alter table public.franchise_trucks
  add column if not exists out_of_service boolean not null default false;

comment on column public.franchise_trucks.out_of_service is
  'Owner-set manual disable. Disabled trucks are hidden from the trucks map/list + board assignment roster and excluded from geofence auto-assign (unusable). Still listed in Truck Setup for re-enabling. Separate from active (telematics-feed presence).';
