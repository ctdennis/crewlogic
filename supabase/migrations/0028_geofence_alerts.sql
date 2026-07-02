-- 0028_geofence_alerts.sql
-- Stores Motive telematics webhook events (geofence entry/exit, ignition on/off, speed, faults)
-- received + signature-verified by the crewlogic-motive-webhook receiver, per franchise/tenant.
-- Plus a small per-franchise geofence_id -> name cache (the webhook payload carries only geofence_id;
-- the name is resolved from Motive's API and cached here, fetch-on-miss).
--
-- Access: RLS enabled, NO permissive policy yet -> service-role only (the receiver writes).
-- The display phase (trucks-map right rail) will add a franchise-scoped SELECT policy + realtime.
-- Retention: a later cron can prune geofence_alerts older than ~30 days (see created_at index).

-- ── Alerts (time-series) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.geofence_alerts (
  id             bigserial PRIMARY KEY,
  franchise_id   uuid NOT NULL,
  tenant_id      uuid,
  action         text,          -- Motive "action": vehicle_geofence_event / engine_toggle_event / ...
  event_type     text,          -- normalized: geofence_entry / geofence_exit / engine_on / engine_off / <action>
  vehicle_id     bigint,
  vehicle_number text,
  geofence_id    bigint,
  geofence_name  text,
  event_id       bigint,        -- Motive's own event id (for dedupe/reference)
  start_time     timestamp with time zone,
  end_time       timestamp with time zone,
  duration       numeric,
  raw            jsonb,
  created_at     timestamp with time zone DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.geofence_alerts ADD CONSTRAINT geofence_alerts_franchise_id_fkey
    FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS geofence_alerts_franchise_created_idx
  ON public.geofence_alerts (franchise_id, created_at DESC);

ALTER TABLE public.geofence_alerts ENABLE ROW LEVEL SECURITY;

-- ── Geofence id -> name cache (per franchise) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.motive_geofences (
  franchise_id uuid NOT NULL,
  geofence_id  bigint NOT NULL,
  name         text,
  updated_at   timestamp with time zone DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.motive_geofences ADD CONSTRAINT motive_geofences_pkey PRIMARY KEY (franchise_id, geofence_id);
EXCEPTION WHEN duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.motive_geofences ADD CONSTRAINT motive_geofences_franchise_id_fkey
    FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.motive_geofences ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS public.motive_geofences;
--   DROP TABLE IF EXISTS public.geofence_alerts;
