-- 0035_franchise_trucks.sql
-- Persistent per-franchise truck list + user-defined map ordering (drag/drop in Truck Setup).
-- Trucks are sourced from the telematics feed (Linxup/Motive) via the crewlogic-trucks edge
-- function; this table only persists identity + the franchise's chosen sort order so the green
-- map-dot numbers are STABLE (Truck "1" is always the same truck) instead of the arbitrary
-- API-return sequence.
--
-- Identity: truck_key = 'vin:<VIN>' when the provider sends a VIN, else 'name:<name>'. A truck
-- that drops off the feed is kept with active=false so its slot/order survives being offline.
--
-- Access: RLS enabled, NO permissive policy -> service-role only. ALL reads/writes go through the
-- crewlogic-trucks edge function (service role), which already holds the telematics creds. The
-- client never touches this table directly.

CREATE TABLE IF NOT EXISTS public.franchise_trucks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise_id uuid NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
  truck_key    text NOT NULL,                    -- 'vin:<VIN>' if present, else 'name:<name>'
  name         text,                             -- last-seen telematics name (display)
  vin          text,
  provider     text,                             -- 'motive' | 'linxup'
  sort_order   int NOT NULL DEFAULT 0,           -- drag/drop map order
  active       boolean NOT NULL DEFAULT true,    -- false when no longer seen in the feed (slot kept)
  created_at   timestamp with time zone DEFAULT now(),
  updated_at   timestamp with time zone DEFAULT now(),
  UNIQUE (franchise_id, truck_key)
);

CREATE INDEX IF NOT EXISTS franchise_trucks_franchise_order_idx
  ON public.franchise_trucks (franchise_id, sort_order);

ALTER TABLE public.franchise_trucks ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS public.franchise_trucks;
