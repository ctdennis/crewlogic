-- 0061_motive_geofences_status.sql
--
-- Adds motive_geofences.status so DEACTIVATED geofences can be hidden from the facility picker
-- without losing their names.
--
-- WHY
-- Motive's GET /v1/geofences returns geofences with status 'active' OR 'deactivated', and their
-- own UI hides the deactivated ones. CrewLogic stored everything it was given, so the picker
-- offered geofences the owner cannot see in Motive and — crucially — that will NEVER fire an
-- event again. Linking a facility to one produces no error and no data: the facility simply
-- stays silent forever, which is indistinguishable from "no trucks visited".
--
-- Owner caught this directly: "when I go to motive, I don't see any geofence named Middleboro
-- Recycling - Metal Recycling yet that value is in the dropdown list? If I selected it, I'd be
-- linking to some phantom geofence, no?" Confirmed on prod — 2884914 refreshed at 23:03 tonight,
-- so Motive still returns it; it is deactivated, not deleted. 2892260 "Santos Scrap Metal -
-- DISABLED" is the same case and was also being offered.
--
-- WHY A COLUMN RATHER THAN JUST SKIPPING THEM ON REFRESH
-- The name cache is also what crewlogic-motive-webhook uses to label incoming alerts, and what
-- the Alerts Report groups historic visits by. Dropping deactivated geofences outright would
-- leave months of past visits at a since-retired facility labelled "(unnamed)". Keeping the row
-- and marking it inactive preserves history while hiding it from a picker where it can only
-- cause harm.
--
-- Existing rows default to 'active': they were captured from a live Motive feed, and the next
-- picker load overwrites the value with the truth.
--
-- Additive only. Idempotent.

alter table public.motive_geofences
  add column if not exists status text not null default 'active';

-- The picker's query: this franchise's active geofences.
create index if not exists motive_geofences_active_idx
  on public.motive_geofences (franchise_id, status);

comment on column public.motive_geofences.status is
  'Provider status: active | deactivated. Deactivated geofences are kept so historic alerts keep their names, but are hidden from the facility picker — they can never fire another event.';
