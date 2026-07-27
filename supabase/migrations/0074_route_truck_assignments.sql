-- 0074_route_truck_assignments.sql
-- Authoritative truck<->route link per service day (FW-59).
-- JOIN TABLE on purpose: multiple rows per (franchise, date, route) are allowed so the
-- deferred multi-truck cases (docs/plan-truck-route-eta.md §3) need NO migration later.
-- Phase-1 UI writes ONE truck per route (the crewlogic-assignments `set` action prunes others).
--
-- Access: RLS enabled, NO permissive policy -> service-role only, mirroring franchise_trucks (0035).
-- ALL reads/writes go through the crewlogic-assignments edge function (service role, scoped by
-- franchise_id). The client NEVER touches this table directly (direct-RLS-token-expiry lesson).

CREATE TABLE IF NOT EXISTS public.route_truck_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise_id    uuid NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
  service_date    date NOT NULL,                        -- franchise-local day (resolved via _shared/tz.ts)
  vonigo_route_id text NOT NULL,                         -- Vonigo route objectID
  route_name      text,
  truck_key       text NOT NULL,                         -- soft ref to franchise_trucks.truck_key; NO FK (history survives roster churn)
  source          text NOT NULL DEFAULT 'manual'         -- 'manual' (hard set) | 'default' (pre-fill) | 'inferred' (geofence auto-set)
                    CHECK (source IN ('manual','default','inferred')),
  confidence      text,                                  -- set on 'inferred'
  assigned_by     text,                                  -- profile email/id of the ops manager (manual)
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  -- join-table-safe: one row per truck-on-route-per-day; allows N trucks (Phase 2) while
  -- blocking a duplicate SAME truck on the same route/day. One-truck rule is app-enforced.
  UNIQUE (franchise_id, service_date, vonigo_route_id, truck_key)
);

CREATE INDEX IF NOT EXISTS rta_lookup_idx
  ON public.route_truck_assignments (franchise_id, service_date, vonigo_route_id);

ALTER TABLE public.route_truck_assignments ENABLE ROW LEVEL SECURITY;

-- Reuse the shared updated_at trigger fn (same one geocode_cache/0019 uses).
DROP TRIGGER IF EXISTS trg_rta_updated ON public.route_truck_assignments;
CREATE TRIGGER trg_rta_updated
  BEFORE UPDATE ON public.route_truck_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS public.route_truck_assignments;
