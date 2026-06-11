-- 0017_profile_pending_trial.sql
--
-- Carries a marketing-signup trial deadline from signup time → the franchise that gets created
-- when the user later connects Vonigo (access matrix cell #4: Marketing + @junkluggers.com).
--
-- A junkluggers marketing signup is provisioned Vonigo-PENDING (profile with franchise_id = NULL)
-- and stamped pending_trial_ends_at = now + 14d AT SIGNUP. The countdown starts when they land on
-- the site, NOT when they connect Vonigo. When they enter their Vonigo credentials,
-- saveVonigoCredentials COPIES this value onto franchises.trial_ends_at (and sets the franchise
-- subscription_status = 'trialing'), then clears this field. Guest-invite junkluggers leave it NULL
-- → their franchise stays 'tester' (never expires) via the shared Junkluggers tenant.
--
-- NULL for every existing/other user → no behavior change.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS pending_trial_ends_at timestamptz;

COMMENT ON COLUMN public.profiles.pending_trial_ends_at IS
  'Marketing-signup trial deadline (now+14d, stamped at signup) for a Vonigo-pending profile. Copied onto franchises.trial_ends_at at Vonigo-connect, then cleared. NULL = no pending trial (guest invite / everyone else).';
