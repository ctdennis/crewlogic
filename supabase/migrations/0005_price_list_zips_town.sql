-- 0005: Town-name price lookup (CL-SPEC-002) — enrich price_list_zips with town/state.
-- Additive + re-runnable.
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0005_price_list_zips_town.sql
-- Apply to prod (at promotion, gated):  supabase db query --linked -f <this file>  (linked to prod)

-- Town + state for each served ZIP, populated client-side from Zippopotam's reverse
-- endpoint (/us/<zip>) — enriched on zip-save and lazily backfilled on first town lookup.
alter table public.price_list_zips add column if not exists city  text;
alter table public.price_list_zips add column if not exists state text;

-- Fast case-insensitive town search per franchise (native town autocomplete).
create index if not exists price_list_zips_city_idx
  on public.price_list_zips (franchise_id, lower(city));
