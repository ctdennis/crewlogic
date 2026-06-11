-- 0016_franchise_subscription_trial.sql
--
-- Per-franchise subscription/trial tracking (provisioning & access matrix, cell #4:
-- Marketing + @junkluggers.com → Vonigo + 14-day trial).
--
-- Why: trial state historically lived only on `tenants` (subscription_status, trial_ends_at).
-- But all Junkluggers franchises share ONE tenant which is 'tester' (never expires), so a single
-- Junkluggers franchise could not carry its own 14-day clock. These nullable columns let an
-- individual franchise override the tenant's clock/status. NULL = inherit from the tenant
-- (preserves today's behavior exactly — every existing row stays NULL, zero regression).
--
-- The access gate reads franchise-first, then tenant (see buildSessionFromSupabaseAuth /
-- crewlogic-oauth-callback): an access value (active/trialing/tester/pro/enterprise) at EITHER
-- level grants access, and a franchise-level trial_ends_at (when set) drives the trial clock
-- ahead of the tenant's.

ALTER TABLE public.franchises
  ADD COLUMN IF NOT EXISTS subscription_status text,
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;

COMMENT ON COLUMN public.franchises.subscription_status IS
  'Per-franchise access status override (active|trialing|tester|pro|enterprise|...). NULL = inherit from tenants.subscription_status. Used so one franchise in a shared tenant (e.g. Junkluggers) can be on its own trial.';
COMMENT ON COLUMN public.franchises.trial_ends_at IS
  'Per-franchise trial clock. NULL = inherit from tenants.trial_ends_at (or no clock). When set, the access gate uses this ahead of the tenant value.';
