-- 0048_card_categories_supplies_maintenance.sql
-- Widen card_merchant_overrides.category to include 'supplies' and 'maintenance' (own P&L lines).
--   supplies    — Hardware stores (HOME DEPOT)
--   maintenance — Maintenance / Tires (AUTOZONE, USED TIRE WAREHOUSE, ADVANCE AUTO)
--
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0048_card_categories_supplies_maintenance.sql
-- Apply to prod (gated): supabase db query --linked -f supabase/migrations/0048_card_categories_supplies_maintenance.sql

alter table public.card_merchant_overrides drop constraint if exists card_merchant_overrides_category_check;
alter table public.card_merchant_overrides add constraint card_merchant_overrides_category_check
  check (category in ('gas', 'disposal', 'supplies', 'maintenance', 'other'));

-- ROLLBACK (manual — only safe if no supplies/maintenance rows exist):
--   alter table public.card_merchant_overrides drop constraint if exists card_merchant_overrides_category_check;
--   alter table public.card_merchant_overrides add constraint card_merchant_overrides_category_check check (category in ('gas','disposal','other'));
