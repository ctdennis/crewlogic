-- 0093_pipeline_close_reason.sql
-- Add a nullable structured close-reason to pipeline_items. Stores the reason a manager
-- gave when closing an item Lost/Dismissed in the Sales Workspace (bizdev). Reason codes:
--   Pricing · Duplicate · Customer unreachable · Items already removed ·
--   Service already performed · Other
-- Free-text column (client sends one of the fixed codes); nullable so existing rows are unaffected.

alter table public.pipeline_items
  add column if not exists close_reason text;

-- Rollback:
--   alter table public.pipeline_items drop column if exists close_reason;
