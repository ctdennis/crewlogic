-- 0078_geocode_cache_confidence.sql
-- FW-63 geocoding accuracy. Adds a confidence signal to geocode_cache so a low-confidence
-- Google result (partial_match, or a coarse location_type like APPROXIMATE/GEOMETRIC_CENTER)
-- is recorded and can be surfaced to the office manager as "address unverified — confirm
-- before dispatch". NULL = legacy row (geocoded before this column existed) — treated as
-- trusted so we don't force a re-geocode of the whole table. 'high' = rooftop/interpolated
-- exact match. 'low' = Google approximated — the pin may be wrong (the Cape Cod
-- village-vs-town class: "3 Harbor Hill Drive, Buzzards Bay" landed on the wrong side of
-- the canal because Google approximated the village centroid instead of the street).
alter table public.geocode_cache
  add column if not exists confidence text
  check (confidence is null or confidence in ('high','low'));

comment on column public.geocode_cache.confidence is
  'FW-63: high = exact rooftop/interpolated match; low = Google approximated (surface as unverified); null = legacy row (trusted).';
