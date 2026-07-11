-- 0038_tier_limits.sql
-- Epic D: tier limits / pricing config in the DB (pricing-never-in-code). One row per tier holds the
-- included headcount + usage caps + the $10 add-on prices. The app reads this to enforce caps, show
-- 80/90/95% warnings, and price the "add a user" / "buy an overage block" add-ons. Change a limit or
-- price here — never in code.
--
-- Seat model (Owner 2026-07-11): billable unit = a USER ID (owner included). Effective cap =
-- included_user_seats + purchased additional seats. Additional user = $10/user/mo (Stripe quantity,
-- bidirectional). Usage caps per §7. Overage block $10 = +25 est / +50 photos (fast-follow).
--
-- Access: RLS on, SELECT permissive (it's public pricing config, like the plans list). Writes are
-- service-role / migration only — the client never writes pricing.

CREATE TABLE IF NOT EXISTS public.tier_limits (
  tier                 text PRIMARY KEY,          -- 'starter' | 'pro' | 'enterprise'
  included_user_seats  int,                        -- NULL = unlimited (enterprise); owner counts toward this
  included_estimates   int NOT NULL,
  included_photos      int NOT NULL,
  overage_block_price  numeric NOT NULL,           -- one-time top-up price
  overage_estimates    int NOT NULL,               -- +estimates per block
  overage_photos       int NOT NULL,               -- +photos per block
  additional_user_price numeric NOT NULL,          -- $/user/mo for seats over the included count
  updated_at           timestamp with time zone DEFAULT now()
);

ALTER TABLE public.tier_limits ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tier_limits_read ON public.tier_limits FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO public.tier_limits
  (tier, included_user_seats, included_estimates, included_photos, overage_block_price, overage_estimates, overage_photos, additional_user_price)
VALUES
  ('starter',    2,  250,  500, 10, 25, 50, 10),
  ('pro',        5,  750, 1500, 10, 25, 50, 10),
  ('enterprise', NULL, 2500, 5000, 10, 25, 50, 10)
ON CONFLICT (tier) DO UPDATE SET
  included_user_seats = EXCLUDED.included_user_seats,
  included_estimates  = EXCLUDED.included_estimates,
  included_photos     = EXCLUDED.included_photos,
  overage_block_price = EXCLUDED.overage_block_price,
  overage_estimates   = EXCLUDED.overage_estimates,
  overage_photos      = EXCLUDED.overage_photos,
  additional_user_price = EXCLUDED.additional_user_price,
  updated_at = now();

-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS public.tier_limits;
