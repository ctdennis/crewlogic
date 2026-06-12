-- 0019_geocode_cache.sql
-- Address → lat/lon cache for the "today's jobs on the truck map" feature.
--
-- Job addresses come from Vonigo as TEXT (no coordinates). We geocode them with
-- the free US Census Geocoder (no API key, US addresses). This table caches each
-- result so a given address is geocoded once and reused forever — instant on
-- repeat map opens, and keeps us well under any rate limit. "Not found" results
-- are cached too (found=false) so a bad/unmatchable address isn't re-attempted
-- on every load.
--
-- Access: RLS enabled, no permissive policies → service-role only. Only the
-- crewlogic-todays-workorders edge function reads/writes it.

CREATE TABLE IF NOT EXISTS public.geocode_cache (
  address_key text PRIMARY KEY,              -- normalized one-line address (lowercased, ws-collapsed)
  lat         double precision,
  lon         double precision,
  found       boolean NOT NULL DEFAULT false, -- did the geocoder return a match?
  provider    text NOT NULL DEFAULT 'census',
  created_at  timestamp with time zone DEFAULT now(),
  updated_at  timestamp with time zone DEFAULT now()
);

ALTER TABLE public.geocode_cache ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_geocode_cache_updated ON public.geocode_cache;
CREATE TRIGGER trg_geocode_cache_updated
  BEFORE UPDATE ON public.geocode_cache
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS public.geocode_cache;
