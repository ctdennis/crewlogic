-- 0037_profile_feature_toggles.sql
-- Epic C: per-user home-tile visibility. The franchise OWNER assigns which home tiles each OTHER
-- user in the franchise sees. One row per (profile, feature_key). If a profile has NO rows at all,
-- the new-user DEFAULT set applies in code: { volumeCheck, priceLookup, manageJobs }. The owner
-- always sees every (capability-allowed) tile — the toggle filter only applies to non-owners.
--
-- Layering: tile visibility = capability-allowed(tile: CRM/telematics/desktop gating, unchanged)
--   AND (user is owner OR toggle enabled). Tiles are a UI concern, NOT a hard security boundary —
--   server endpoints still enforce actual access/usage caps (Epic D).
--
-- REGRESSION GUARD (Owner 2026-07-11): existing users must NOT be downgraded. A backfill grants every
-- existing NON-owner profile explicit ON toggles for all tiles EXCEPT the owner-only trio
-- (router, trucks, truckAlerts) — i.e. exactly what estimators could already see — so nobody loses a
-- tile when this ships. New users created afterward get the default set.
--
-- RLS: enabled with a permissive policy matching the app's existing anon team-management posture
-- (profiles are already read AND deleted via the anon key, franchise-scoped client-side). Tighter
-- owner-only RLS is a possible follow-up; tile visibility is not a security boundary.

CREATE TABLE IF NOT EXISTS public.profile_feature_toggles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  feature_key  text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  updated_at   timestamp with time zone DEFAULT now(),
  UNIQUE (profile_id, feature_key)
);

CREATE INDEX IF NOT EXISTS profile_feature_toggles_profile_idx
  ON public.profile_feature_toggles (profile_id);

ALTER TABLE public.profile_feature_toggles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY profile_feature_toggles_all ON public.profile_feature_toggles
    FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- BACKFILL (run once, after the table exists — see the frontend/edge rollout; kept here for record).
-- Grants existing non-owner profiles ON toggles for all tiles except the owner-only trio so nobody
-- is downgraded. Idempotent via ON CONFLICT. The tile list mirrors index.html's .module-card set.
--   INSERT INTO public.profile_feature_toggles (profile_id, feature_key, enabled)
--   SELECT p.id, k.key, true
--   FROM public.profiles p
--   CROSS JOIN (VALUES ('estimates'),('volumeCheck'),('priceLookup'),('manageJobs'),('dashboard'),
--                      ('estimatesDashboard'),('jobPlan'),('signs'),('disposalRouter')) AS k(key)
--   WHERE COALESCE(p.role,'owner') <> 'owner'
--   ON CONFLICT (profile_id, feature_key) DO NOTHING;
--
-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS public.profile_feature_toggles;
