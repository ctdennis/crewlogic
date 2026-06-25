-- 0026_usage_caps_overage.sql
-- Round-1 billing: per-franchise usage-cap overrides + the automatic-overage toggle.
-- Tier DEFAULT caps live in code (TIER_CAPS: starter 250 est/500 photos · pro 750/1500 · enterprise 2500/5000).
-- These columns let a franchise RAISE its caps independent of tier (NULL = use the tier default), and turn
-- automatic overage on/off. Period usage (estimates + photos this billing period) is derived from the live
-- `usage_events` log (estimates already metered; photo-upload metering added with this work) — not stored here.

ALTER TABLE public.franchises
  ADD COLUMN IF NOT EXISTS est_cap_override integer,        -- NULL = use tier default
  ADD COLUMN IF NOT EXISTS photo_cap_override integer,      -- NULL = use tier default
  ADD COLUMN IF NOT EXISTS auto_overage_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.franchises.est_cap_override IS
  'Per-franchise monthly estimate cap override (NULL = tier default). Raised independent of subscription_tier.';
COMMENT ON COLUMN public.franchises.photo_cap_override IS
  'Per-franchise monthly photo cap override (NULL = tier default).';
COMMENT ON COLUMN public.franchises.auto_overage_enabled IS
  'When true, exceeding a cap auto-charges bundled overage blocks (~$10 = +25 est & +50 photos) via Stripe metered billing; when false, hard-stop at the cap.';

-- Rollback:
--   ALTER TABLE public.franchises
--     DROP COLUMN IF EXISTS est_cap_override,
--     DROP COLUMN IF EXISTS photo_cap_override,
--     DROP COLUMN IF EXISTS auto_overage_enabled;
