-- 0033_telematics_consolidation.sql
-- Consolidated telematics setup: store credentials for BOTH providers (Motive +
-- Linxup) simultaneously with a single per-franchise `is_active` flag deciding
-- which provider feeds the trucks map; plus a Linxup webhook receiver secret
-- (mirrors 0027_motive_webhook_secret.sql for the push side).
--
-- Part 1 — telematics_credentials: single-slot → per-provider.
--   * UNIQUE(franchise_id) → UNIQUE(franchise_id, provider) (both providers can coexist).
--   * Add is_active boolean; exactly one active row per franchise. Existing single
--     rows stay active (default true) and KEEP their stored secret_name (no Vault
--     rename) — the name is always read from the column.
--   * upsert_telematics_credential: upsert by (franchise_id, provider); NEW writes
--     use Vault name 'telematics_token_<fid>_<provider>'; activates the upserted
--     provider and deactivates the franchise's other provider.
--   * set_active_telematics_provider(fid, provider): flip active WITHOUT touching
--     tokens; returns false (no-op) if that provider row doesn't exist.
--   * get_telematics_credential(fid): returns the ACTIVE row (crewlogic-trucks +
--     crewlogic-motive-webhook behavior unchanged — they read the active provider).
--   * get_telematics_status(fid): PER-PROVIDER rows (so the UI shows both expanders).
--   * set_telematics_status: now keyed by (franchise_id, provider).
--
-- Part 2 — linxup_webhook_config: mirrors 0027 for Linxup. We GENERATE the token
--   (crewlogic-settings), Owner pastes it into Linxup; the crewlogic-linxup-webhook
--   receiver verifies the incoming Bearer token against it (attribution via ?f=).
--   Vault secret name 'linxup_webhook_secret_<franchise_id>'.
--
-- Access: all RPCs SECURITY DEFINER + service-role only (matches 0018/0027). The
-- token/secret are never returned to the client except saveLinxupWebhookSecret's
-- one-time generated-token return (handled in the edge function, not here).

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — telematics_credentials → per-provider + is_active
-- ═════════════════════════════════════════════════════════════════════════════

-- Drop the single-slot uniqueness; add per-(franchise, provider) uniqueness.
ALTER TABLE public.telematics_credentials
  DROP CONSTRAINT IF EXISTS telematics_credentials_franchise_id_key;

DO $$ BEGIN
  ALTER TABLE public.telematics_credentials
    ADD CONSTRAINT telematics_credentials_franchise_provider_key UNIQUE (franchise_id, provider);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Which provider feeds the trucks map. Existing single rows → active (default true).
ALTER TABLE public.telematics_credentials
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- ── Write: store provider + token per-provider; activate it, deactivate others ─
CREATE OR REPLACE FUNCTION public.upsert_telematics_credential(
  p_franchise_id uuid,
  p_provider     text,
  p_token        text
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
  IF p_provider NOT IN ('motive','linxup') THEN
    RAISE EXCEPTION 'invalid provider: %', p_provider;
  END IF;

  -- Row for THIS provider (both providers can coexist for one franchise).
  SELECT * INTO v_existing
  FROM telematics_credentials
  WHERE franchise_id = p_franchise_id AND provider = p_provider;

  IF v_existing IS NULL THEN
    -- NEW writes get a per-provider Vault secret name.
    v_secret_name := 'telematics_token_' || replace(p_franchise_id::text, '-', '_') || '_' || p_provider;
    v_secret_id := vault.create_secret(
      p_token,
      v_secret_name,
      'Telematics API token for franchise ' || p_franchise_id::text || ' (' || p_provider || ')'
    );
    INSERT INTO telematics_credentials (franchise_id, provider, secret_name, status, is_active)
    VALUES (p_franchise_id, p_provider, v_secret_name, 'pending', true);
  ELSE
    -- Existing rows KEEP their stored secret_name (may be the legacy single-slot name).
    v_secret_name := v_existing.secret_name;
    SELECT id INTO v_secret_id FROM vault.secrets WHERE name = v_secret_name;
    PERFORM vault.update_secret(
      v_secret_id,
      p_token,
      v_secret_name,
      'Telematics API token for franchise ' || p_franchise_id::text || ' (' || p_provider || ')'
    );
    UPDATE telematics_credentials
    SET status = 'pending',
        is_active = true,
        updated_at = now()
    WHERE franchise_id = p_franchise_id AND provider = p_provider;
  END IF;

  -- Exactly one active provider: deactivate the franchise's OTHER provider row(s).
  UPDATE telematics_credentials
  SET is_active = false, updated_at = now()
  WHERE franchise_id = p_franchise_id AND provider <> p_provider;

  INSERT INTO telematics_credential_audit (franchise_id, action, performed_by)
  VALUES (p_franchise_id, CASE WHEN v_existing IS NULL THEN 'created' ELSE 'updated' END, 'crewlogic-settings');

  RETURN v_secret_name;
END;
$function$
;

-- ── Write: flip the active provider WITHOUT changing any token ────────────────
CREATE OR REPLACE FUNCTION public.set_active_telematics_provider(
  p_franchise_id uuid,
  p_provider     text
)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF p_provider NOT IN ('motive','linxup') THEN
    RAISE EXCEPTION 'invalid provider: %', p_provider;
  END IF;

  -- No-op-safe: if that provider isn't configured for this franchise, do nothing.
  IF NOT EXISTS (
    SELECT 1 FROM telematics_credentials
    WHERE franchise_id = p_franchise_id AND provider = p_provider
  ) THEN
    RETURN false;
  END IF;

  UPDATE telematics_credentials
  SET is_active = (provider = p_provider), updated_at = now()
  WHERE franchise_id = p_franchise_id;

  INSERT INTO telematics_credential_audit (franchise_id, action, performed_by)
  VALUES (p_franchise_id, 'updated', 'crewlogic-settings');

  RETURN true;
END;
$function$
;

-- ── Read: ACTIVE provider + decrypted token (crewlogic-trucks / motive-webhook) ─
CREATE OR REPLACE FUNCTION public.get_telematics_credential(p_franchise_id uuid)
 RETURNS TABLE(provider text, token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  INSERT INTO telematics_credential_audit (franchise_id, action, performed_by)
  VALUES (p_franchise_id, 'fetched', 'crewlogic-trucks');

  RETURN QUERY
  SELECT tc.provider,
         ds.decrypted_secret::text AS token
  FROM telematics_credentials tc
  JOIN vault.decrypted_secrets ds ON ds.name = tc.secret_name
  WHERE tc.franchise_id = p_franchise_id
    AND tc.is_active = true
  LIMIT 1;
END;
$function$
;

-- ── Read: PER-PROVIDER non-secret status for the Settings UI (NO token) ───────
-- Return type changed → drop then recreate.
DROP FUNCTION IF EXISTS public.get_telematics_status(uuid);
CREATE OR REPLACE FUNCTION public.get_telematics_status(p_franchise_id uuid)
 RETURNS TABLE(
   provider          text,
   configured        boolean,
   status            text,
   last_truck_count  integer,
   last_error        text,
   last_validated_at timestamp with time zone,
   is_active         boolean
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT tc.provider,
         true AS configured,
         tc.status,
         tc.last_truck_count,
         tc.last_error,
         tc.last_validated_at,
         tc.is_active
  FROM telematics_credentials tc
  WHERE tc.franchise_id = p_franchise_id;
END;
$function$
;

-- ── Write: stamp validation result, keyed by (franchise_id, provider) ─────────
-- Arg signature changed → drop the old (uuid, text, integer, text) first.
DROP FUNCTION IF EXISTS public.set_telematics_status(uuid, text, integer, text);
CREATE OR REPLACE FUNCTION public.set_telematics_status(
  p_franchise_id uuid,
  p_provider     text,
  p_status       text,
  p_truck_count  integer,
  p_error        text
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  UPDATE telematics_credentials
  SET status = p_status,
      last_truck_count = p_truck_count,
      last_error = p_error,
      last_validated_at = now(),
      updated_at = now()
  WHERE franchise_id = p_franchise_id AND provider = p_provider;

  INSERT INTO telematics_credential_audit (franchise_id, action, performed_by)
  VALUES (p_franchise_id, 'validated', 'crewlogic-settings');
END;
$function$
;

-- ── Permissions: SECURITY DEFINER (one returns the decrypted token) → service-role ONLY.
REVOKE ALL ON FUNCTION public.upsert_telematics_credential(uuid, text, text)          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_active_telematics_provider(uuid, text)              FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_telematics_credential(uuid)                         FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_telematics_status(uuid)                             FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_telematics_status(uuid, text, text, integer, text)  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_telematics_credential(uuid, text, text)          TO service_role;
GRANT EXECUTE ON FUNCTION public.set_active_telematics_provider(uuid, text)              TO service_role;
GRANT EXECUTE ON FUNCTION public.get_telematics_credential(uuid)                         TO service_role;
GRANT EXECUTE ON FUNCTION public.get_telematics_status(uuid)                             TO service_role;
GRANT EXECUTE ON FUNCTION public.set_telematics_status(uuid, text, text, integer, text)  TO service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — linxup_webhook_config (mirror of 0027_motive_webhook_secret.sql)
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.linxup_webhook_config (
  franchise_id uuid NOT NULL,
  secret_name  text NOT NULL,                       -- Vault secret reference
  status       text NOT NULL DEFAULT 'configured',  -- 'configured'
  created_at   timestamp with time zone DEFAULT now(),
  updated_at   timestamp with time zone DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.linxup_webhook_config ADD CONSTRAINT linxup_webhook_config_pkey PRIMARY KEY (franchise_id);
EXCEPTION WHEN duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.linxup_webhook_config ADD CONSTRAINT linxup_webhook_config_secret_name_key UNIQUE (secret_name);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.linxup_webhook_config ADD CONSTRAINT linxup_webhook_config_franchise_id_fkey
    FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.linxup_webhook_config ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_linxup_webhook_config_updated ON public.linxup_webhook_config;
CREATE TRIGGER trg_linxup_webhook_config_updated
  BEFORE UPDATE ON public.linxup_webhook_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Write: store the receiver token (token → Vault) ──────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_linxup_webhook_secret(
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
  v_secret_name := 'linxup_webhook_secret_' || replace(p_franchise_id::text, '-', '_');

  SELECT * INTO v_existing FROM linxup_webhook_config WHERE franchise_id = p_franchise_id;

  IF v_existing IS NULL THEN
    v_secret_id := vault.create_secret(
      p_secret, v_secret_name, 'Linxup webhook receiver token for franchise ' || p_franchise_id::text
    );
    INSERT INTO linxup_webhook_config (franchise_id, secret_name, status)
    VALUES (p_franchise_id, v_secret_name, 'configured');
  ELSE
    SELECT id INTO v_secret_id FROM vault.secrets WHERE name = v_secret_name;
    PERFORM vault.update_secret(
      v_secret_id, p_secret, v_secret_name, 'Linxup webhook receiver token for franchise ' || p_franchise_id::text
    );
    UPDATE linxup_webhook_config SET status = 'configured', updated_at = now() WHERE franchise_id = p_franchise_id;
  END IF;

  RETURN v_secret_name;
END;
$function$
;

-- ── Read: decrypted token (service-role callers only — the receiver) ──────────
CREATE OR REPLACE FUNCTION public.get_linxup_webhook_secret(p_franchise_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_secret text;
BEGIN
  SELECT ds.decrypted_secret::text INTO v_secret
  FROM linxup_webhook_config lc
  JOIN vault.decrypted_secrets ds ON ds.name = lc.secret_name
  WHERE lc.franchise_id = p_franchise_id;
  RETURN v_secret;
END;
$function$
;

-- ── Read: non-secret status for the Settings UI (NO secret) ───────────────────
CREATE OR REPLACE FUNCTION public.get_linxup_webhook_status(p_franchise_id uuid)
 RETURNS TABLE(configured boolean, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT true AS configured, lc.updated_at
  FROM linxup_webhook_config lc
  WHERE lc.franchise_id = p_franchise_id;
END;
$function$
;

-- ── Permissions: SECURITY DEFINER + one returns the decrypted secret → service-role ONLY.
REVOKE ALL ON FUNCTION public.upsert_linxup_webhook_secret(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_linxup_webhook_secret(uuid)          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_linxup_webhook_status(uuid)          FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_linxup_webhook_secret(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_linxup_webhook_secret(uuid)          TO service_role;
GRANT EXECUTE ON FUNCTION public.get_linxup_webhook_status(uuid)          TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual):
--   -- Part 2
--   DROP FUNCTION IF EXISTS public.get_linxup_webhook_status(uuid);
--   DROP FUNCTION IF EXISTS public.get_linxup_webhook_secret(uuid);
--   DROP FUNCTION IF EXISTS public.upsert_linxup_webhook_secret(uuid, text);
--   DROP TABLE IF EXISTS public.linxup_webhook_config;
--   (Vault secrets named 'linxup_webhook_secret_*' removed separately if desired.)
--   -- Part 1 (restore single-slot signatures from 0018)
--   DROP FUNCTION IF EXISTS public.set_active_telematics_provider(uuid, text);
--   DROP FUNCTION IF EXISTS public.set_telematics_status(uuid, text, text, integer, text);
--   DROP FUNCTION IF EXISTS public.get_telematics_status(uuid);
--   ALTER TABLE public.telematics_credentials DROP CONSTRAINT IF EXISTS telematics_credentials_franchise_provider_key;
--   ALTER TABLE public.telematics_credentials DROP COLUMN IF EXISTS is_active;
--   ALTER TABLE public.telematics_credentials ADD CONSTRAINT telematics_credentials_franchise_id_key UNIQUE (franchise_id);
--   (then re-run 0018's get_telematics_status / set_telematics_status / upsert bodies)
