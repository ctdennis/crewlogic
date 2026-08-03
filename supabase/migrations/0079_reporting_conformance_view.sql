-- 0079_reporting_conformance_view.sql
-- FW-62 Analysis Engine — conformed "dwell" fact. Resolves the two dimension-key mismatches that a
-- naive query gets wrong, WITHOUT new tables (the joins already exist on real columns):
--   * Facility: geofence_alerts.geofence_id = facilities.provider_geofence_id (exact; covers 1827/1836
--     of #90's exit rows). facility_id is NULL for non-facility geofences (fuel / office / customer / test).
--   * Truck: geofence_alerts.vehicle_number = franchise_trucks.name (per franchise). truck_id is NULL for
--     a vehicle number not in the current fleet (e.g. retired "Truck 7").
-- One row per real dwell = a geofence_exit whose `duration` (seconds) already carries the whole visit.
-- start_time is UTC — the reporting skill converts to the FRANCHISE timezone before any day-of-week /
-- hour filter (never assume Eastern for a non-Eastern franchise). Measure-level hygiene (drop <120s
-- edge-clip blips, cap >7200s missed-exits) is applied by each report skill, not baked in here, so the
-- view stays a raw conformed fact reusable by dwell, utilization, and future measures.
--
-- Rollback: drop view if exists v_geofence_dwell;

create or replace view v_geofence_dwell as
select
  ga.franchise_id,
  ga.id                as alert_id,
  ga.start_time,                          -- UTC (convert to franchise TZ in the skill)
  ga.duration          as dwell_seconds,
  ga.vehicle_number,
  ft.id                as truck_id,       -- NULL = vehicle_number not in the current fleet
  ft.name              as truck_name,
  ga.geofence_id,
  ga.geofence_name,
  f.id                 as facility_id,    -- NULL = geofence isn't a known facility
  f.name               as facility_name,
  f.type               as facility_type,
  ga.wo_id,
  ga.job_id
from geofence_alerts ga
left join facilities f
  on f.franchise_id = ga.franchise_id and f.provider_geofence_id = ga.geofence_id
left join franchise_trucks ft
  on ft.franchise_id = ga.franchise_id and ft.name = ga.vehicle_number
where ga.event_type = 'geofence_exit'
  and ga.duration is not null;

comment on view v_geofence_dwell is
  'FW-62: conformed dwell fact. geofence_exit rows with facility_id (via facilities.provider_geofence_id) and truck_id (via franchise_trucks.name) resolved. start_time is UTC; apply franchise TZ + blip/miss hygiene in the reporting skill.';
