-- 0039_billing_addons.sql
-- Epic D crediting last-mile: make a paid add-on actually grant something.
--   • additional_seats — current PAID additional-user quantity (the $10/mo seats on the subscription).
--     Effective user cap = tier included_user_seats + additional_seats. Synced by crewlogic-billing
--     (adjustSeats + the subscription.updated webhook).
--   • overage_* — bonus allowance bought via one-time $10 overage blocks, scoped to a billing period.
--     On a paid overage (checkout.session.completed, addon=overage) the webhook adds +25 est / +50
--     photos; when overage_period rolls to a new period the credits reset to 0. usageSummary adds
--     these to the tier caps only while overage_period matches the current period.

ALTER TABLE public.franchises
  ADD COLUMN IF NOT EXISTS additional_seats     int  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS overage_est_credit   int  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS overage_photo_credit int  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS overage_period       text;

-- ROLLBACK (manual):
--   ALTER TABLE public.franchises
--     DROP COLUMN IF EXISTS additional_seats,
--     DROP COLUMN IF EXISTS overage_est_credit,
--     DROP COLUMN IF EXISTS overage_photo_credit,
--     DROP COLUMN IF EXISTS overage_period;
