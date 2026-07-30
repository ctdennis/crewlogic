-- 0076_route_volume_estimates.sql
-- FW-60 Phase 1: AI volume-estimate cache, one row per (franchise, service_date, wo_id).
-- Holds the AI's {low,high} cu-yd estimate for a dispatch job, cached by desc_hash so an edited
-- description (customer adds/removes items) re-estimates while an unchanged one is free. Also carries
-- a nullable crew ACTUAL override (the per-segment slider result) and an EO-converted flag.
--
-- Access: RLS enabled, NO permissive policy -> service-role only, mirroring route_truck_assignments
-- (0074) / franchise_trucks (0035). ALL reads/writes go through the crewlogic-volume edge function
-- (service role, scoped by franchise_id); the client NEVER touches this table directly
-- (direct-RLS-token-expiry lesson).

CREATE TABLE IF NOT EXISTS public.route_volume_estimates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise_id  uuid NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
  service_date  date NOT NULL,                     -- franchise-local day (resolved via _shared/tz.ts)
  wo_id         text NOT NULL,                     -- Vonigo WorkOrder objectID (the segment/job)
  low_cuyd      numeric,                           -- AI low estimate (cubic yards)
  high_cuyd     numeric,                           -- AI high estimate (cubic yards)
  confidence    text,                              -- 'low' | 'medium' | 'high' (AI self-report)
  model         text,                              -- model that produced the estimate (telemetry)
  desc_hash     text,                              -- hash(summary + items); mismatch on reload => re-estimate. NULL on an actual-only row (slider/EO set before any AI estimate) — nullable so setActual/setEoConverted never clobber a real hash
  estimated_at  timestamptz NOT NULL DEFAULT now(),
  actual_cuyd   numeric,                           -- crew/ops override (per-segment slider); NULL = use AI
  actual_set_by text,                              -- who set the actual (profile email/id)
  actual_set_at timestamptz,
  eo_converted  boolean,                           -- estimate-only job the crew converted to a haul (counts in fill)
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  UNIQUE (franchise_id, service_date, wo_id)
);

CREATE INDEX IF NOT EXISTS rve_lookup_idx
  ON public.route_volume_estimates (franchise_id, service_date);

ALTER TABLE public.route_volume_estimates ENABLE ROW LEVEL SECURITY;

-- Reuse the shared updated_at trigger fn (same one route_truck_assignments/0074 + geocode_cache/0019 use).
DROP TRIGGER IF EXISTS trg_rve_updated ON public.route_volume_estimates;
CREATE TRIGGER trg_rve_updated
  BEFORE UPDATE ON public.route_volume_estimates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS public.route_volume_estimates;
