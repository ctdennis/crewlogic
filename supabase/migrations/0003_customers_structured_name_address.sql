-- 0003: Stage A — structured name + address on customers. Additive + re-runnable.
-- Splits the single free-text name/address into integration-ready fields. The legacy
-- `name` and `address` columns are KEPT and auto-composed (display name / full address)
-- so existing reads keep working. `zip` already exists (pricing key).
--
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0003_customers_structured_name_address.sql
-- Apply to prod (at promotion, gated, linked to prod):  supabase db query --linked -f <this file>

-- Name: company (commercial) + first/last (person / commercial contact)
alter table public.customers add column if not exists company    text;
alter table public.customers add column if not exists first_name text;
alter table public.customers add column if not exists last_name  text;

-- Address: street (required for Street View cover photo + routing) + city + state.
-- zip already exists. address (full) kept + auto-composed by the app.
alter table public.customers add column if not exists street text;
alter table public.customers add column if not exists city   text;
alter table public.customers add column if not exists state  text;
