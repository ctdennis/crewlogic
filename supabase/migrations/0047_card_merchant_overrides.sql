-- 0047_card_merchant_overrides.sql
-- Per-vendor category overrides for the Motive Card reclass tool (super-admin / #90-internal only).
--
-- product_type auto-classifies most transactions (fuel→gas, Business&professional services/Utilities
-- →disposal, else→other). This table lets the owner OVERRIDE the category for any merchant (a vendor is
-- consistently one category — e.g. TOWN OF BOURNE is always disposal even on its no-product_type charges).
-- Keyed by (franchise_id, merchant_name); one row per vendor.
--
-- Accessed only by the crewlogic-card-transactions edge function (service role) — the client never reads
-- it directly. RLS on with no client policy = deny to anon/authenticated; service role bypasses RLS.
--
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0047_card_merchant_overrides.sql
-- Apply to prod (gated): supabase db query --linked -f supabase/migrations/0047_card_merchant_overrides.sql

create table if not exists public.card_merchant_overrides (
  id            bigint generated always as identity primary key,
  franchise_id  text not null,
  merchant_name text not null,
  category      text not null check (category in ('gas', 'disposal', 'other')),
  updated_at    timestamptz not null default now(),
  unique (franchise_id, merchant_name)
);

alter table public.card_merchant_overrides enable row level security;

-- ROLLBACK (manual):
--   drop table if exists public.card_merchant_overrides;
