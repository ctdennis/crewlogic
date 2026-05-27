-- Sample default price book for the DEV1 (none) tenant. Re-runnable.
-- Volume block uses item names the estimator matches on (findVolumeItem: name.includes('1/8','Full',…))
-- and unit_of_measure 'volume' (decimal-allowed). Apply (dev):
--   bash supabase/dev-setup/dev-sql.sh -f supabase/dev-setup/seed_pricing_dev.sql

delete from public.price_list_zips where franchise_id = '22222222-2222-2222-2222-222222222222';
delete from public.price_lists     where franchise_id = '22222222-2222-2222-2222-222222222222';  -- cascades blocks + items

insert into public.price_lists (id, franchise_id, name, is_default)
values ('a0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Standard Price List', true);

insert into public.price_blocks (id, price_list_id, name, block_type, sequence) values
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Volume',     'volume',    1),
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'Surcharges', 'surcharge', 2),
  ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'Labor',      'labor',     3);

insert into public.price_items (price_block_id, name, value, unit_of_measure, fraction_value, sequence) values
  ('b0000000-0000-0000-0000-000000000001', 'Minimum',                89,  'volume', 0.0625, 1),
  ('b0000000-0000-0000-0000-000000000001', '1/8 Truckload',          149, 'volume', 0.125,  2),
  ('b0000000-0000-0000-0000-000000000001', '1/4 Truckload',          229, 'volume', 0.25,   3),
  ('b0000000-0000-0000-0000-000000000001', '3/8 Truckload',          309, 'volume', 0.375,  4),
  ('b0000000-0000-0000-0000-000000000001', '1/2 Truckload',          389, 'volume', 0.5,    5),
  ('b0000000-0000-0000-0000-000000000001', '5/8 Truckload',          459, 'volume', 0.625,  6),
  ('b0000000-0000-0000-0000-000000000001', '3/4 Truckload',          529, 'volume', 0.75,   7),
  ('b0000000-0000-0000-0000-000000000001', '7/8 Truckload',          599, 'volume', 0.875,  8),
  ('b0000000-0000-0000-0000-000000000001', 'Full Truckload',         669, 'volume', 1.0,    9),
  ('b0000000-0000-0000-0000-000000000002', 'Stairs (per flight)',    25,  'flight', null,   1),
  ('b0000000-0000-0000-0000-000000000002', 'Long Carry',             35,  'ea',     null,   2),
  ('b0000000-0000-0000-0000-000000000003', 'Extra Labor (per hour)', 75,  'hour',   null,   1);
