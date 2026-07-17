-- 0049_quickbooks_credentials.sql
-- OAuth2 tokens for the QuickBooks reclass auto-post (super-admin / #90-internal only).
-- One row per franchise. Accessed ONLY by the crewlogic-quickbooks edge function (service role);
-- the client never reads it. RLS on with no client policy = deny to anon/authenticated.
--
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0049_quickbooks_credentials.sql
-- Apply to prod (gated): supabase db query --linked -f supabase/migrations/0049_quickbooks_credentials.sql

create table if not exists public.quickbooks_credentials (
  id            bigint generated always as identity primary key,
  franchise_id  text not null unique,
  environment   text not null default 'sandbox' check (environment in ('sandbox', 'production')),
  realm_id      text,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,          -- access-token expiry
  connected_at  timestamptz,
  updated_at    timestamptz not null default now()
);

alter table public.quickbooks_credentials enable row level security;

-- ROLLBACK (manual):
--   drop table if exists public.quickbooks_credentials;
