-- 0001: preserve an estimate's status across soft-delete/restore.
-- Soft-delete sets status='deleted', which loses the prior status (won/lost/draft).
-- This column records the status the estimate had before deletion so Restore can
-- return it exactly (fallback 'draft' when null, e.g. rows deleted before this change).
-- Additive + idempotent. Apply to dev, then to prod at promotion:
--   supabase db query --linked -f supabase/migrations/0001_add_status_before_delete.sql
alter table public.estimates add column if not exists status_before_delete text;
