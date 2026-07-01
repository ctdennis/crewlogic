-- 0030_job_geofences.sql
-- Maps a CrewLogic/Vonigo job (work order) to the temporary Motive geofence created
-- for it, so the webhook receiver can turn a geofence_entry/exit into an
-- "arrived at / left <client>" alert (Phase B) and delete-on-exit + an end-of-day
-- sweep can clean the geofence up (Phase C).
--
-- Lifecycle: sync fn CREATEs a Motive "Job Site" geofence per today's job and inserts
-- a row here (status='active'); on the exit event the receiver DELETEs the geofence and
-- marks the row status='deleted', deleted_at=now(). The partial unique index keeps ONE
-- active geofence per (franchise, work order) while allowing historical deleted rows.
--
-- Service-role only (the sync fn + receiver write it); no client access — the alerts
-- surface via geofence_alerts, not this table.

create table if not exists public.job_geofences (
  id                bigserial primary key,
  franchise_id      uuid not null,
  tenant_id         uuid,
  wo_id             text not null,           -- Vonigo work order objectID (unique per appointment)
  job_id            text,                    -- Vonigo job objectID (shared across "copy to another day")
  vonigo_job_number text,                    -- human-facing job/WO number when known
  geofence_id       bigint,                  -- Motive geofence id (motive.geofence.id)
  name              text,                    -- geofence name we set ("<client> · #<woID>")
  centre_lat        double precision,
  centre_lon        double precision,
  status            text not null default 'active',   -- 'active' | 'deleted'
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

-- One ACTIVE geofence per (franchise, work order) — makes the sync idempotent while
-- preserving historical deleted rows for audit.
create unique index if not exists job_geofences_active_uniq
  on public.job_geofences (franchise_id, wo_id) where status = 'active';

-- Fast lookup by geofence_id for the receiver's match + delete-on-exit.
create index if not exists job_geofences_geofence_id_idx
  on public.job_geofences (geofence_id) where status = 'active';

alter table public.job_geofences enable row level security;
-- No policies: service-role only (sync fn + receiver). Not exposed to clients.
