-- 0060_visits_key_on_geofence_not_facility.sql
--
-- Drops telematics_visits.facility_id. Visits resolve their facility by GEOFENCE ID instead.
--
-- WHY — a data-loss bug found before the UI was built.
-- crewlogic-settings `saveFacilities` is a REPLACE-SET: it deletes every facility row for the
-- franchise and re-inserts them (crewlogic-settings/index.ts:1083-1096). Facility UUIDs are
-- therefore regenerated on EVERY settings save. Since 0057 declared
--     facility_id uuid references facilities(id) on delete set null
-- an owner editing anything on the facilities screen -- a phone number, one site's hours --
-- would have silently NULLed facility_id on every historical visit, detaching months of
-- recorded recycling revenue from the recycler it belongs to. No error, no warning.
--
-- The fix follows from D1 rather than fighting it. The whole premise of this work is that a
-- facility's identity IS its telematics geofence id, not a surrogate key: names drift and rows
-- get recreated, the geofence id does not. A visit already stores provider + provider_geofence_id,
-- so it can resolve its facility by joining
--     telematics_visits.(franchise_id, provider, provider_geofence_id)
--       -> facilities.(franchise_id, provider, provider_geofence_id)
-- which 0056's unique index already serves. That join is stable across replace-set saves,
-- survives a facility being deleted and re-added, and removes the second source of truth.
--
-- Keeping facility_id as a cache was considered and rejected: it would have to be re-resolved
-- after every settings save, and a stale cache pointing at a deleted row is exactly the class
-- of silent wrongness this migration exists to remove.
--
-- Safe on dev: the column is unused (no rows carry a non-null facility_id).
-- Idempotent.

drop index if exists public.telematics_visits_facility_idx;

alter table public.telematics_visits drop column if exists facility_id;

-- The replacement lookup path: "every visit at this franchise's facility X".
create index if not exists telematics_visits_franchise_geofence_idx
  on public.telematics_visits (franchise_id, provider, provider_geofence_id, started_at desc);

comment on column public.telematics_visits.provider_geofence_id is
  'The facility link. Join to facilities(franchise_id, provider, provider_geofence_id). Deliberately NOT a FK to facilities.id -- saveFacilities is a replace-set that regenerates facility UUIDs on every save.';
