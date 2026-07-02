-- 0027_motive_webhook_secret.sql
-- Per-franchise Motive geofence-webhook SIGNING SECRET.
--
-- Motive signs each webhook POST with HMAC-SHA1(rawBody, secret) in the
-- `x-kt-webhook-signature` header. The crewlogic-motive-webhook receiver verifies
-- incoming alerts against the franchise's stored secret (attribution via ?f=<franchiseID>).
--
-- Mirrors the vonigo_credentials / telematics_credentials → Supabase Vault pattern:
-- the secret is stored ENCRYPTED in Vault; this table holds only a reference
-- (secret_name) + non-secret status. Kept SEPARATE from telematics_credentials so a
-- franchise can configure geofence alerts independent of the trucks-map API token
-- (telematics_credentials requires a NOT NULL provider + token).
--
-- Access: RLS enabled, NO permissive policies → service-role only. The frontend
-- goes through crewlogic-settings (write + status), the receiver through
-- get_motive_webhook_secret. The secret is NEVER returned to the client.

-- ── Table ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.motive_webhook_config (
  franchise_id uuid NOT NULL,
  secret_name  text NOT NULL,                       -- Vault secret reference
  status       text NOT NULL DEFAULT 'configured',  -- 'configured'
  created_at   timestamp with time zone DEFAULT now(),
  updated_at   timestamp with time zone DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.motive_webhook_config ADD CONSTRAINT motive_webhook_config_pkey PRIMARY KEY (franchise_id);
EXCEPTION WHEN duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.motive_webhook_config ADD CONSTRAINT motive_webhook_config_secret_name_key UNIQUE (secret_name);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.motive_webhook_config ADD CONSTRAINT motive_webhook_config_franchise_id_fkey
    FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.motive_webhook_config ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_motive_webhook_config_updated ON public.motive_webhook_config;
CREATE TRIGGER trg_motive_webhook_config_updated
  BEFORE UPDATE ON public.motive_webhook_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Write: store the signing secret (secret → Vault) ─────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_motive_webhook_secret(
  p_franchise_id uuid,
  p_secret       text
)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_secret_name text;
  v_secret_id   uuid;
  v_existing    record;
BEGIN
  v_secret_name := 'motive_webhook_secret_' || replace(p_franchise_id::text, '-', '_');

  SELECT * INTO v_existing FROM motive_webhook_config WHERE franchise_id = p_franchise_id;

  IF v_existing IS NULL THEN
    v_secret_id := vault.create_secret(
      p_secret, v_secret_name, 'Motive webhook signing secret for franchise ' || p_franchise_id::text
    );
    INSERT INTO motive_webhook_config (franchise_id, secret_name, status)
    VALUES (p_franchise_id, v_secret_name, 'configured');
  ELSE
    SELECT id INTO v_secret_id FROM vault.secrets WHERE name = v_secret_name;
    PERFORM vault.update_secret(
      v_secret_id, p_secret, v_secret_name, 'Motive webhook signing secret for franchise ' || p_franchise_id::text
    );
    UPDATE motive_webhook_config SET status = 'configured', updated_at = now() WHERE franchise_id = p_franchise_id;
  END IF;

  RETURN v_secret_name;
END;
$function$
;

-- ── Read: decrypted secret (service-role callers only — the receiver) ─────────
CREATE OR REPLACE FUNCTION public.get_motive_webhook_secret(p_franchise_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_secret text;
BEGIN
  SELECT ds.decrypted_secret::text INTO v_secret
  FROM motive_webhook_config mc
  JOIN vault.decrypted_secrets ds ON ds.name = mc.secret_name
  WHERE mc.franchise_id = p_franchise_id;
  RETURN v_secret;
END;
$function$
;

-- ── Read: non-secret status for the Settings UI (NO secret) ──────────────────
CREATE OR REPLACE FUNCTION public.get_motive_webhook_status(p_franchise_id uuid)
 RETURNS TABLE(configured boolean, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT true AS configured, mc.updated_at
  FROM motive_webhook_config mc
  WHERE mc.franchise_id = p_franchise_id;
END;
$function$
;

-- ── Permissions: SECURITY DEFINER + one returns the decrypted secret → service-role ONLY.
REVOKE ALL ON FUNCTION public.upsert_motive_webhook_secret(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_motive_webhook_secret(uuid)          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_motive_webhook_status(uuid)          FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_motive_webhook_secret(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_motive_webhook_secret(uuid)          TO service_role;
GRANT EXECUTE ON FUNCTION public.get_motive_webhook_status(uuid)          TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual):
--   DROP FUNCTION IF EXISTS public.get_motive_webhook_status(uuid);
--   DROP FUNCTION IF EXISTS public.get_motive_webhook_secret(uuid);
--   DROP FUNCTION IF EXISTS public.upsert_motive_webhook_secret(uuid, text);
--   DROP TABLE IF EXISTS public.motive_webhook_config;
--   (Vault secrets named 'motive_webhook_secret_*' must be removed separately if desired.)
