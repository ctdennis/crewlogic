-- 0036_profiles_role_check.sql
-- Epic B (dispatch role): constrain profiles.role to the known role set so a typo'd or stray role
-- value can never silently break access-gating. 'dispatch' is the new free/unlimited role (board,
-- trucks, routes, job plans; cannot create estimates).
--
-- Audited 2026-07-11 (read-only, both envs): prod profiles = owner(10)/estimator(4); dev = owner(5).
-- All code writers write only 'owner'/'estimator' (the 'user'/'assistant' role literals in the app
-- + edge fns are Claude chat-message roles, NOT profile roles). So this CHECK rejects nothing in use.
-- NULL is permitted (buildSessionFromSupabaseAuth defaults a null role to 'owner').
--
-- REGRESSION GUARD (B0): this ONLY adds a CHECK constraint. No existing profiles.role is changed.

DO $$ BEGIN
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
    CHECK (role IS NULL OR role IN ('owner', 'estimator', 'dispatch'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ROLLBACK (manual):
--   ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
