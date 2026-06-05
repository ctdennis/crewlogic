-- 0013: backfill estimate_charges from existing estimates.payload->'charges'. Phase 2.
-- DATA op (not schema). Idempotent — it rebuilds estimate_charges from the blob (full delete + reinsert),
-- so it's safe to re-run, but ONLY while nothing else writes the table (i.e. BEFORE dual-write/Phase 3
-- goes live). After running, verify per-estimate row counts match jsonb_array_length(payload->'charges').
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0013_backfill_estimate_charges.sql
-- Apply to prod: gated, at promotion (run once before dual-write).

delete from public.estimate_charges;

insert into public.estimate_charges
  (estimate_id, franchise_id, sequence, type, area, room, name, description, qty, unit_price, truck_volume, data)
select
  e.estimate_id,
  e.franchise_id,
  (c.ord - 1)::int                              as sequence,
  c.charge->>'type',
  c.charge->>'area',
  c.charge->>'room',
  c.charge->>'name',
  c.charge->>'description',
  nullif(c.charge->>'qty','')::numeric,
  nullif(c.charge->>'unitPrice','')::numeric,
  nullif(c.charge->>'truckVolume','')::numeric,
  c.charge                                       as data
from public.estimates e
  cross join lateral jsonb_array_elements(e.payload->'charges') with ordinality as c(charge, ord)
where jsonb_typeof(e.payload->'charges') = 'array'
  and e.franchise_id is not null
  and jsonb_typeof(c.charge) = 'object';
