-- 0018_telematics_credentials.sql
-- Per-franchise telematics ("Where Are My Trucks?") credentials.
--
-- Mirrors the vonigo_credentials → Supabase Vault pattern: the actual API
-- key/token is stored ENCRYPTED in Vault; this table holds only a reference
-- (secret_name), the chosen provider, and non-secret validation status.
--
-- One provider per franchise (motive | linxup), either/or. A franchise that
-- switches providers reuses the same per-franchise secret slot (the token is
-- overwritten; only the provider column changes).
--
-- Access: RLS enabled with NO permissive policies → service-role only. The
-- frontend never reads this table directly; it goes through the
-- crewlogic-settings (write + validate) and crewlogic-trucks (read) edge
-- functions, which use the SECURITY DEFINER RPCs below. The token is never
-- returned to the client.

-- ── Tables ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.telematics_credentials (
  id                uuid DEFAULT gen_random_uuid() NOT NULL,
  franchise_id      uuid NOT NULL,
  provider          text NOT NULL,                  -- 'motive' | 'linxup'
  secret_name       text NOT NULL,                  -- Vault secret reference
  status            text NOT NULL DEFAULT 'pending', -- 'pending' | 'connected' | 'error'
  last_validated_at timestamp with time zone,
  last_truck_count  integer,
  last_error        text,
  created_at        timestamp with time zone DEFAULT now(),
  updated_at        timestamp with time zone DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.telematics_credentials ADD CONSTRAINT telematics_credentials_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.telematics_credentials ADD CONSTRAINT telematics_credentials_franchise_id_key UNIQUE (franchise_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.telematics_credentials ADD CONSTRAINT telematics_credentials_secret_name_key UNIQUE (secret_name);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.telematics_credentials ADD CONSTRAINT telematics_credentials_provider_chk CHECK (provider IN ('motive','linxup'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.telematics_credentials ADD CONSTRAINT telematics_credentials_franchise_id_fkey
    FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.telematics_credentials ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.telematics_credential_audit (
  id           uuid DEFAULT gen_random_uuid() NOT NULL,
  franchise_id uuid NOT NULL,
  action       text NOT NULL,                       -- 'created' | 'updated' | 'fetched' | 'validated'
  performed_by text,
  created_at   timestamp with time zone DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.telematics_credential_audit ADD CONSTRAINT telematics_credential_audit_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR invalid_table_definition THEN NULL; END $$;

ALTER TABLE public.telematics_credential_audit ENABLE ROW LEVEL SECURITY;

-- ── updated_at trigger ───────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_telematics_credentials_updated ON public.telematics_credentials;
CREATE TRIGGER trg_telematics_credentials_updated
  BEFORE UPDATE ON public.telematics_credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Write: store provider + token (token → Vault) ────────────────────────────
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

  -- Provider-independent per-franchise secret slot (one token at a time).
  v_secret_name := 'telematics_token_' || replace(p_franchise_id::text, '-', '_');

  SELECT * INTO v_existing
  FROM telematics_credentials
  WHERE franchise_id = p_franchise_id;

  IF v_existing IS NULL THEN
    v_secret_id := vault.create_secret(
      p_token,
      v_secret_name,
      'Telematics API token for franchise ' || p_franchise_id::text
    );
    INSERT INTO telematics_credentials (franchise_id, provider, secret_name, status)
    VALUES (p_franchise_id, p_provider, v_secret_name, 'pending');
  ELSE
    SELECT id INTO v_secret_id FROM vault.secrets WHERE name = v_secret_name;
    PERFORM vault.update_secret(
      v_secret_id,
      p_token,
      v_secret_name,
      'Telematics API token for franchise ' || p_franchise_id::text
    );
    UPDATE telematics_credentials
    SET provider = p_provider,
        status = 'pending',
        updated_at = now()
    WHERE franchise_id = p_franchise_id;
  END IF;

  INSERT INTO telematics_credential_audit (franchise_id, action, performed_by)
  VALUES (p_franchise_id, CASE WHEN v_existing IS NULL THEN 'created' ELSE 'updated' END, 'crewlogic-settings');

  RETURN v_secret_name;
END;
$function$
;

-- ── Read: provider + decrypted token (service-role callers only) ─────────────
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
  WHERE tc.franchise_id = p_franchise_id;
END;
$function$
;

-- ── Read: non-secret status for the Settings UI (NO token) ───────────────────
CREATE OR REPLACE FUNCTION public.get_telematics_status(p_franchise_id uuid)
 RETURNS TABLE(provider text, status text, last_truck_count integer, last_validated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT tc.provider, tc.status, tc.last_truck_count, tc.last_validated_at
  FROM telematics_credentials tc
  WHERE tc.franchise_id = p_franchise_id;
END;
$function$
;

-- ── Write: stamp validation result (called after a live test call) ───────────
CREATE OR REPLACE FUNCTION public.set_telematics_status(
  p_franchise_id uuid,
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
  WHERE franchise_id = p_franchise_id;

  INSERT INTO telematics_credential_audit (franchise_id, action, performed_by)
  VALUES (p_franchise_id, 'validated', 'crewlogic-settings');
END;
$function$
;

-- ── Permissions: these RPCs are SECURITY DEFINER and one returns the decrypted
--    token, so they must be callable by the SERVICE ROLE ONLY. The edge functions
--    (crewlogic-settings write/validate, crewlogic-trucks read) call them with the
--    service-role key. Revoking PUBLIC also removes anon + authenticated.
REVOKE ALL ON FUNCTION public.upsert_telematics_credential(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_telematics_credential(uuid)              FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_telematics_status(uuid)                  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_telematics_status(uuid, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_telematics_credential(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_telematics_credential(uuid)              TO service_role;
GRANT EXECUTE ON FUNCTION public.get_telematics_status(uuid)                  TO service_role;
GRANT EXECUTE ON FUNCTION public.set_telematics_status(uuid, text, integer, text) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual):
--   DROP FUNCTION IF EXISTS public.set_telematics_status(uuid, text, integer, text);
--   DROP FUNCTION IF EXISTS public.get_telematics_status(uuid);
--   DROP FUNCTION IF EXISTS public.get_telematics_credential(uuid);
--   DROP FUNCTION IF EXISTS public.upsert_telematics_credential(uuid, text, text);
--   DROP TABLE IF EXISTS public.telematics_credential_audit;
--   DROP TABLE IF EXISTS public.telematics_credentials;
--   (Vault secrets named 'telematics_token_*' must be removed separately if desired.)
