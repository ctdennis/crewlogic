-- 0025_stripe_billing.sql
-- Round-1 monetization: Stripe self-serve billing columns on `franchises` (the billing unit).
-- Prices live in Stripe (pricing-never-in-code); these columns only LINK a franchise to its Stripe
-- customer/subscription and CACHE the current price id + period end that the Stripe webhook writes.
-- subscription_status / subscription_tier already exist (migration 0016) and remain the access gate.

ALTER TABLE public.franchises
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS stripe_price_id text,
  ADD COLUMN IF NOT EXISTS subscription_current_period_end timestamptz;

COMMENT ON COLUMN public.franchises.stripe_customer_id IS
  'Stripe Customer id for this franchise (billing unit). Set on first checkout.';
COMMENT ON COLUMN public.franchises.stripe_subscription_id IS
  'Active Stripe Subscription id; set/cleared by the Stripe webhook on create/cancel.';
COMMENT ON COLUMN public.franchises.stripe_price_id IS
  'Stripe Price id the franchise is subscribed to (maps to plan/tier; resolved at runtime, never hardcoded).';
COMMENT ON COLUMN public.franchises.subscription_current_period_end IS
  'End of the current paid period (from Stripe); for grace/renewal display.';

CREATE INDEX IF NOT EXISTS idx_franchises_stripe_customer ON public.franchises (stripe_customer_id);

-- Rollback:
--   DROP INDEX IF EXISTS idx_franchises_stripe_customer;
--   ALTER TABLE public.franchises
--     DROP COLUMN IF EXISTS stripe_customer_id,
--     DROP COLUMN IF EXISTS stripe_subscription_id,
--     DROP COLUMN IF EXISTS stripe_price_id,
--     DROP COLUMN IF EXISTS subscription_current_period_end;
