-- 0021_home_card_order.sql — per-user home-screen card order (drag-to-reorder preference)
alter table public.profiles add column if not exists home_card_order jsonb;
-- Rollback: alter table public.profiles drop column if exists home_card_order;
