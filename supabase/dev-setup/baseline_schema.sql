CREATE TYPE public.campaign_status AS ENUM ('active', 'paused', 'completed');

CREATE TYPE public.crew_member_status AS ENUM ('active', 'inactive');

CREATE TYPE public.reward_status AS ENUM ('pending', 'issued', 'failed', 'test');

CREATE TYPE public.session_status AS ENUM ('pending', 'active', 'completed', 'rejected');

CREATE TYPE public.sign_status AS ENUM ('active', 'gray', 'hidden', 'retrieved', 'gone');

CREATE TABLE IF NOT EXISTS public.campaigns (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  franchise_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  start_date date,
  end_date date,
  status campaign_status DEFAULT 'active'::campaign_status NOT NULL,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.crew_members (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  franchise_id uuid NOT NULL,
  auth_user_id uuid,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  phone text,
  status crew_member_status DEFAULT 'active'::crew_member_status NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.customer_price_lists (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  franchise_id uuid,
  vonigo_client_id text NOT NULL,
  name text NOT NULL,
  contact_name text,
  notes text,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  surcharge_discounts jsonb DEFAULT '{}'::jsonb,
  zip text
);

CREATE TABLE IF NOT EXISTS public.estimates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  estimate_id bigint,
  franchise_id uuid NOT NULL,
  owner_email text,
  label text,
  client_name text,
  address text,
  zip text,
  status text DEFAULT 'draft'::text,
  total_price numeric,
  total_trucks numeric,
  split_pricing boolean DEFAULT true,
  vonigo_quote_id integer,
  job_id text,
  client_id text,
  contact_id text,
  location_id text,
  cover_photo text,
  payload jsonb DEFAULT '{}'::jsonb,
  cost_analysis jsonb DEFAULT '{}'::jsonb,
  cloned_from bigint,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  price_book jsonb DEFAULT '[]'::jsonb,
  deleted_at timestamp with time zone,
  client_phone text,
  customer_price_list text,
  status_before_delete text
);

CREATE TABLE IF NOT EXISTS public.feedback (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_email text NOT NULL,
  user_name text,
  user_role text,
  franchise_id uuid,
  message text NOT NULL,
  screenshot_url text,
  context jsonb DEFAULT '{}'::jsonb,
  status text DEFAULT 'new'::text NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.franchises (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  tenant_id uuid NOT NULL,
  external_id text NOT NULL,
  franchise_name text,
  cost_settings jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  subscription_tier text DEFAULT 'free'::text,
  signs_settings jsonb DEFAULT '{}'::jsonb,
  vonigo_configured boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.invites (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  franchise_id uuid,
  email text NOT NULL,
  role text DEFAULT 'estimator'::text NOT NULL,
  token text DEFAULT encode(gen_random_bytes(32), 'hex'::text) NOT NULL,
  invited_by uuid,
  accepted_at timestamp with time zone,
  expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval),
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.job_plans (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  tenant_id uuid NOT NULL,
  franchise_id uuid NOT NULL,
  plan_date date NOT NULL,
  routes jsonb NOT NULL,
  total_jobs integer DEFAULT 0,
  ai_model text,
  ai_metadata jsonb,
  generated_at timestamp with time zone DEFAULT now() NOT NULL,
  last_edited_at timestamp with time zone,
  created_by uuid
);

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  franchise_id uuid,
  email text NOT NULL,
  name text,
  role text DEFAULT 'estimator'::text,
  created_at timestamp with time zone DEFAULT now(),
  invited_by uuid,
  accepted_invite_id uuid,
  auth_user_id uuid
);

CREATE TABLE IF NOT EXISTS public.sign_credits (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  franchise_id uuid NOT NULL,
  crew_member_id uuid NOT NULL,
  sign_id uuid NOT NULL,
  session_id uuid NOT NULL,
  credits_earned integer DEFAULT 1 NOT NULL,
  awarded_at timestamp with time zone DEFAULT now() NOT NULL,
  consumed_by_reward uuid
);

CREATE TABLE IF NOT EXISTS public.sign_rewards (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  franchise_id uuid NOT NULL,
  crew_member_id uuid NOT NULL,
  credits_consumed integer NOT NULL,
  reward_amount_dollars numeric(10,2) NOT NULL,
  status reward_status DEFAULT 'pending'::reward_status NOT NULL,
  test_mode boolean DEFAULT false NOT NULL,
  promovault_request jsonb,
  promovault_response jsonb,
  promovault_reward_id text,
  error_message text,
  issued_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  reward_link text
);

CREATE TABLE IF NOT EXISTS public.sign_sessions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  franchise_id uuid NOT NULL,
  campaign_id uuid,
  crew_member_ids uuid[] NOT NULL,
  status session_status DEFAULT 'pending'::session_status NOT NULL,
  approval_token text,
  approval_requested_at timestamp with time zone,
  approved_at timestamp with time zone,
  approved_by uuid,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  ended_at timestamp with time zone,
  signs_placed_count integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sign_status_events (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  franchise_id uuid NOT NULL,
  sign_id uuid NOT NULL,
  from_status sign_status,
  to_status sign_status NOT NULL,
  event_type text NOT NULL,
  triggered_by uuid,
  notes text,
  occurred_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.tenants (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  crm_type text,
  crm_config jsonb DEFAULT '{}'::jsonb,
  brand_settings jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  subscription_status text DEFAULT 'trialing'::text NOT NULL,
  trial_ends_at timestamp with time zone,
  stripe_customer_id text,
  stripe_subscription_id text
);

CREATE TABLE IF NOT EXISTS public.tools (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  tenant_id uuid NOT NULL,
  franchise_id uuid,
  name text NOT NULL,
  category text,
  description text,
  use_case text,
  is_on_truck boolean DEFAULT false NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  external_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.vonigo_credential_audit (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  franchise_id uuid NOT NULL,
  action text NOT NULL,
  performed_at timestamp with time zone DEFAULT now(),
  performed_by text
);

CREATE TABLE IF NOT EXISTS public.vonigo_credentials (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  franchise_id uuid NOT NULL,
  vonigo_username text NOT NULL,
  secret_name text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.yard_signs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  franchise_id uuid NOT NULL,
  session_id uuid NOT NULL,
  campaign_id uuid,
  placed_by_ids uuid[] NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  address text,
  gps_source text,
  photo_path text,
  photo_thumb_path text,
  status sign_status DEFAULT 'active'::sign_status NOT NULL,
  placed_at timestamp with time zone DEFAULT now() NOT NULL,
  last_refreshed_at timestamp with time zone,
  retrieved_at timestamp with time zone,
  retrieved_by uuid,
  gone_at timestamp with time zone,
  gone_by uuid,
  grayed_at timestamp with time zone,
  hidden_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  ai_check_passed boolean,
  ai_check_response jsonb,
  ai_check_at timestamp with time zone
);

ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);

ALTER TABLE public.crew_members ADD CONSTRAINT crew_members_franchise_id_email_key UNIQUE (franchise_id, email);

ALTER TABLE public.crew_members ADD CONSTRAINT crew_members_pkey PRIMARY KEY (id);

ALTER TABLE public.customer_price_lists ADD CONSTRAINT customer_price_lists_pkey PRIMARY KEY (id);

ALTER TABLE public.estimates ADD CONSTRAINT estimates_pkey PRIMARY KEY (id);

ALTER TABLE public.estimates ADD CONSTRAINT estimates_estimate_id_key UNIQUE (estimate_id);

ALTER TABLE public.feedback ADD CONSTRAINT feedback_pkey PRIMARY KEY (id);

ALTER TABLE public.franchises ADD CONSTRAINT franchises_pkey PRIMARY KEY (id);

ALTER TABLE public.franchises ADD CONSTRAINT franchises_tenant_id_external_id_key UNIQUE (tenant_id, external_id);

ALTER TABLE public.franchises ADD CONSTRAINT franchises_subscription_tier_check CHECK ((subscription_tier = ANY (ARRAY['free'::text, 'pro'::text, 'enterprise'::text, 'tester'::text])));

ALTER TABLE public.franchises ADD CONSTRAINT franchises_external_id_unique UNIQUE (external_id);

ALTER TABLE public.invites ADD CONSTRAINT invites_pkey PRIMARY KEY (id);

ALTER TABLE public.invites ADD CONSTRAINT invites_token_key UNIQUE (token);

ALTER TABLE public.job_plans ADD CONSTRAINT job_plans_pkey PRIMARY KEY (id);

ALTER TABLE public.job_plans ADD CONSTRAINT job_plans_unique_per_date UNIQUE (tenant_id, franchise_id, plan_date);

ALTER TABLE public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);

ALTER TABLE public.profiles ADD CONSTRAINT profiles_email_key UNIQUE (email);

ALTER TABLE public.sign_credits ADD CONSTRAINT sign_credits_sign_id_crew_member_id_key UNIQUE (sign_id, crew_member_id);

ALTER TABLE public.sign_credits ADD CONSTRAINT sign_credits_pkey PRIMARY KEY (id);

ALTER TABLE public.sign_rewards ADD CONSTRAINT sign_rewards_pkey PRIMARY KEY (id);

ALTER TABLE public.sign_sessions ADD CONSTRAINT sign_sessions_crew_member_ids_check CHECK (((array_length(crew_member_ids, 1) >= 1) AND (array_length(crew_member_ids, 1) <= 2)));

ALTER TABLE public.sign_sessions ADD CONSTRAINT sign_sessions_pkey PRIMARY KEY (id);

ALTER TABLE public.sign_status_events ADD CONSTRAINT sign_status_events_pkey PRIMARY KEY (id);

ALTER TABLE public.tenants ADD CONSTRAINT tenants_slug_key UNIQUE (slug);

ALTER TABLE public.tenants ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);

ALTER TABLE public.tools ADD CONSTRAINT tools_pkey PRIMARY KEY (id);

ALTER TABLE public.vonigo_credential_audit ADD CONSTRAINT vonigo_credential_audit_pkey PRIMARY KEY (id);

ALTER TABLE public.vonigo_credentials ADD CONSTRAINT vonigo_credentials_franchise_id_key UNIQUE (franchise_id);

ALTER TABLE public.vonigo_credentials ADD CONSTRAINT vonigo_credentials_pkey PRIMARY KEY (id);

ALTER TABLE public.vonigo_credentials ADD CONSTRAINT vonigo_credentials_secret_name_key UNIQUE (secret_name);

ALTER TABLE public.yard_signs ADD CONSTRAINT yard_signs_pkey PRIMARY KEY (id);

ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_franchise_id_fkey FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE;

ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.crew_members ADD CONSTRAINT crew_members_franchise_id_fkey FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE;

ALTER TABLE public.crew_members ADD CONSTRAINT crew_members_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.customer_price_lists ADD CONSTRAINT customer_price_lists_franchise_id_fkey FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE;

ALTER TABLE public.estimates ADD CONSTRAINT estimates_franchise_id_fkey FOREIGN KEY (franchise_id) REFERENCES franchises(id);

ALTER TABLE public.feedback ADD CONSTRAINT feedback_franchise_id_fkey FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE SET NULL;

ALTER TABLE public.franchises ADD CONSTRAINT franchises_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE public.invites ADD CONSTRAINT invites_franchise_id_fkey FOREIGN KEY (franchise_id) REFERENCES franchises(id);

ALTER TABLE public.invites ADD CONSTRAINT invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES profiles(id);

ALTER TABLE public.profiles ADD CONSTRAINT profiles_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES profiles(id);

ALTER TABLE public.profiles ADD CONSTRAINT profiles_accepted_invite_id_fkey FOREIGN KEY (accepted_invite_id) REFERENCES invites(id);

ALTER TABLE public.profiles ADD CONSTRAINT profiles_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.profiles ADD CONSTRAINT profiles_franchise_id_fkey FOREIGN KEY (franchise_id) REFERENCES franchises(id);

ALTER TABLE public.sign_credits ADD CONSTRAINT sign_credits_consumed_by_reward_fkey FOREIGN KEY (consumed_by_reward) REFERENCES sign_rewards(id) ON DELETE SET NULL;

ALTER TABLE public.sign_credits ADD CONSTRAINT sign_credits_crew_member_id_fkey FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE CASCADE;

ALTER TABLE public.sign_credits ADD CONSTRAINT sign_credits_franchise_id_fkey FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE;

ALTER TABLE public.sign_credits ADD CONSTRAINT sign_credits_session_id_fkey FOREIGN KEY (session_id) REFERENCES sign_sessions(id) ON DELETE CASCADE;

ALTER TABLE public.sign_credits ADD CONSTRAINT sign_credits_sign_id_fkey FOREIGN KEY (sign_id) REFERENCES yard_signs(id) ON DELETE CASCADE;

ALTER TABLE public.sign_rewards ADD CONSTRAINT sign_rewards_crew_member_id_fkey FOREIGN KEY (crew_member_id) REFERENCES crew_members(id) ON DELETE CASCADE;

ALTER TABLE public.sign_rewards ADD CONSTRAINT sign_rewards_franchise_id_fkey FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE;

ALTER TABLE public.sign_sessions ADD CONSTRAINT sign_sessions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id);

ALTER TABLE public.sign_sessions ADD CONSTRAINT sign_sessions_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;

ALTER TABLE public.sign_sessions ADD CONSTRAINT sign_sessions_franchise_id_fkey FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE;

ALTER TABLE public.sign_status_events ADD CONSTRAINT sign_status_events_franchise_id_fkey FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE;

ALTER TABLE public.sign_status_events ADD CONSTRAINT sign_status_events_sign_id_fkey FOREIGN KEY (sign_id) REFERENCES yard_signs(id) ON DELETE CASCADE;

ALTER TABLE public.sign_status_events ADD CONSTRAINT sign_status_events_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES crew_members(id);

ALTER TABLE public.vonigo_credentials ADD CONSTRAINT vonigo_credentials_franchise_id_fkey FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE;

ALTER TABLE public.yard_signs ADD CONSTRAINT yard_signs_franchise_id_fkey FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE;

ALTER TABLE public.yard_signs ADD CONSTRAINT yard_signs_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;

ALTER TABLE public.yard_signs ADD CONSTRAINT yard_signs_gone_by_fkey FOREIGN KEY (gone_by) REFERENCES crew_members(id);

ALTER TABLE public.yard_signs ADD CONSTRAINT yard_signs_retrieved_by_fkey FOREIGN KEY (retrieved_by) REFERENCES crew_members(id);

ALTER TABLE public.yard_signs ADD CONSTRAINT yard_signs_session_id_fkey FOREIGN KEY (session_id) REFERENCES sign_sessions(id) ON DELETE CASCADE;

CREATE INDEX idx_campaigns_active ON public.campaigns USING btree (franchise_id, status) WHERE (status = 'active'::campaign_status);

CREATE INDEX idx_campaigns_franchise ON public.campaigns USING btree (franchise_id);

CREATE INDEX idx_crew_members_status ON public.crew_members USING btree (franchise_id, status);

CREATE INDEX idx_crew_members_franchise ON public.crew_members USING btree (franchise_id);

CREATE INDEX idx_crew_members_auth_user ON public.crew_members USING btree (auth_user_id);

CREATE INDEX idx_cpl_franchise_client ON public.customer_price_lists USING btree (franchise_id, vonigo_client_id);

CREATE INDEX idx_estimates_client ON public.estimates USING btree (franchise_id, client_name);

CREATE INDEX idx_estimates_status ON public.estimates USING btree (franchise_id, status);

CREATE INDEX idx_estimates_franchise_updated ON public.estimates USING btree (franchise_id, updated_at DESC);

CREATE INDEX feedback_status_created_idx ON public.feedback USING btree (status, created_at DESC);

CREATE INDEX feedback_franchise_idx ON public.feedback USING btree (franchise_id, created_at DESC);

CREATE INDEX idx_franchises_tenant ON public.franchises USING btree (tenant_id);

CREATE INDEX idx_invites_franchise ON public.invites USING btree (franchise_id);

CREATE INDEX idx_invites_token ON public.invites USING btree (token);

CREATE INDEX idx_job_plans_franchise_date ON public.job_plans USING btree (franchise_id, plan_date DESC);

CREATE INDEX idx_profiles_auth_user_id ON public.profiles USING btree (auth_user_id);

CREATE INDEX idx_sign_credits_franchise ON public.sign_credits USING btree (franchise_id);

CREATE INDEX idx_sign_credits_crew ON public.sign_credits USING btree (crew_member_id);

CREATE INDEX idx_sign_credits_unconsumed ON public.sign_credits USING btree (crew_member_id) WHERE (consumed_by_reward IS NULL);

CREATE INDEX idx_sign_rewards_status ON public.sign_rewards USING btree (franchise_id, status);

CREATE INDEX idx_sign_rewards_crew ON public.sign_rewards USING btree (crew_member_id);

CREATE INDEX idx_sign_rewards_franchise ON public.sign_rewards USING btree (franchise_id);

CREATE INDEX idx_sign_sessions_campaign ON public.sign_sessions USING btree (campaign_id);

CREATE INDEX idx_sign_sessions_started ON public.sign_sessions USING btree (franchise_id, started_at DESC);

CREATE INDEX idx_sign_sessions_token ON public.sign_sessions USING btree (approval_token) WHERE (approval_token IS NOT NULL);

CREATE INDEX idx_sign_sessions_franchise ON public.sign_sessions USING btree (franchise_id);

CREATE INDEX idx_sign_sessions_status ON public.sign_sessions USING btree (franchise_id, status);

CREATE INDEX idx_sign_events_franchise ON public.sign_status_events USING btree (franchise_id, occurred_at DESC);

CREATE INDEX idx_sign_events_sign ON public.sign_status_events USING btree (sign_id, occurred_at DESC);

CREATE INDEX idx_tools_active ON public.tools USING btree (is_active) WHERE (is_active = true);

CREATE UNIQUE INDEX tools_unique_name_per_franchise ON public.tools USING btree (franchise_id, lower(name)) WHERE (is_active = true);

CREATE INDEX idx_tools_tenant_franchise ON public.tools USING btree (tenant_id, franchise_id);

CREATE INDEX idx_yard_signs_status ON public.yard_signs USING btree (franchise_id, status);

CREATE INDEX idx_yard_signs_campaign ON public.yard_signs USING btree (campaign_id);

CREATE INDEX idx_yard_signs_session ON public.yard_signs USING btree (session_id);

CREATE INDEX idx_yard_signs_ai_check ON public.yard_signs USING btree (franchise_id, ai_check_passed) WHERE (ai_check_passed IS NOT TRUE);

CREATE INDEX idx_yard_signs_franchise ON public.yard_signs USING btree (franchise_id);

CREATE INDEX idx_yard_signs_active_age ON public.yard_signs USING btree (franchise_id, placed_at) WHERE (status = ANY (ARRAY['active'::sign_status, 'gray'::sign_status]));

CREATE INDEX idx_yard_signs_placed ON public.yard_signs USING btree (franchise_id, placed_at DESC);

CREATE OR REPLACE FUNCTION public.get_vonigo_credential(p_franchise_id uuid)
 RETURNS TABLE(vonigo_username text, vonigo_md5 text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  -- Audit the fetch
  INSERT INTO vonigo_credential_audit (franchise_id, action, performed_by)
  VALUES (p_franchise_id, 'fetched', 'n8n-api-call');
 
  RETURN QUERY
  SELECT
    vc.vonigo_username,
    ds.decrypted_secret::text as vonigo_md5
  FROM vonigo_credentials vc
  JOIN vault.decrypted_secrets ds ON ds.name = vc.secret_name
  WHERE vc.franchise_id = p_franchise_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.signs_daily_lifecycle()
 RETURNS TABLE(grayed_count bigint, hidden_count bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with to_gray as (
    update yard_signs ys set status='gray', updated_at=now() from franchises f
    where ys.franchise_id=f.id and ys.status='active'
      and ys.placed_at < now() - (coalesce((f.cost_settings->'signs'->>'graySignDays')::int,15)||' days')::interval
    returning ys.id, ys.franchise_id
  ),
  gray_events as (
    insert into sign_status_events (franchise_id, sign_id, from_status, to_status, event_type)
    select franchise_id, id, 'active','gray','auto_aged' from to_gray returning 1
  ),
  to_hidden as (
    update yard_signs ys set status='hidden', updated_at=now() from franchises f
    where ys.franchise_id=f.id and ys.status='gray'
      and ys.placed_at < now() - (coalesce((f.cost_settings->'signs'->>'hiddenSignDays')::int,60)||' days')::interval
    returning ys.id, ys.franchise_id
  ),
  hidden_events as (
    insert into sign_status_events (franchise_id, sign_id, from_status, to_status, event_type)
    select franchise_id, id, 'gray','hidden','auto_aged' from to_hidden returning 1
  )
  select (select count(*) from to_gray)::bigint, (select count(*) from to_hidden)::bigint;
$function$
;

CREATE OR REPLACE FUNCTION public.sweep_find_expired_photos()
 RETURNS TABLE(estimate_id bigint, franchise_id uuid, expired_paths jsonb)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with expanded as (
    select e.estimate_id, e.franchise_id,
      (dp.deleted_entry->>'path') as path,
      (dp.deleted_entry->>'deletedAt')::timestamptz as deleted_at
    from estimates e
    cross join lateral jsonb_array_elements(e.payload->'charges') as c(charge)
    cross join lateral jsonb_array_elements(coalesce(c.charge->'deletedPhotos','[]'::jsonb)) as dp(deleted_entry)
    where c.charge->'deletedPhotos' is not null and jsonb_array_length(c.charge->'deletedPhotos') > 0
  )
  select expanded.estimate_id, expanded.franchise_id, jsonb_agg(expanded.path order by expanded.deleted_at) as expired_paths
  from expanded where expanded.deleted_at < (now() - interval '30 days')
  group by expanded.estimate_id, expanded.franchise_id order by expanded.estimate_id;
$function$
;

CREATE OR REPLACE FUNCTION public.sweep_prune_expired_photos(p_estimate_id bigint, p_expired_paths jsonb)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update estimates e set payload = jsonb_set(e.payload, '{charges}', (
    select jsonb_agg(case when c->'deletedPhotos' is null then c
      else jsonb_set(c, '{deletedPhotos}', coalesce((select jsonb_agg(dp) from jsonb_array_elements(c->'deletedPhotos') as dp where not (p_expired_paths ? (dp->>'path'))), '[]'::jsonb)) end order by idx)
    from jsonb_array_elements(e.payload->'charges') with ordinality as t(c, idx))),
  updated_at = now() where e.estimate_id = p_estimate_id;
$function$
;

CREATE OR REPLACE FUNCTION public.update_feedback_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_vonigo_credential(p_franchise_id uuid, p_username text, p_md5 text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_secret_name text;
  v_secret_id   uuid;
  v_existing    record;
BEGIN
  v_secret_name := 'vonigo_md5_' || replace(p_franchise_id::text, '-', '_');

  -- Check if credential already exists
  SELECT * INTO v_existing
  FROM vonigo_credentials
  WHERE franchise_id = p_franchise_id;

  IF v_existing IS NULL THEN
    -- Create new vault secret (returns uuid directly in pgsodium 3.x)
    v_secret_id := vault.create_secret(
      p_md5,
      v_secret_name,
      'Vonigo MD5 credential for franchise ' || p_franchise_id::text
    );

    -- Store the reference
    INSERT INTO vonigo_credentials (franchise_id, vonigo_username, secret_name)
    VALUES (p_franchise_id, p_username, v_secret_name);

  ELSE
    -- Update existing vault secret
    SELECT id INTO v_secret_id
    FROM vault.secrets
    WHERE name = v_secret_name;

    PERFORM vault.update_secret(
      v_secret_id,
      p_md5,
      v_secret_name,
      'Vonigo MD5 credential for franchise ' || p_franchise_id::text
    );

    -- Update the reference record
    UPDATE vonigo_credentials
    SET vonigo_username = p_username,
        updated_at = now()
    WHERE franchise_id = p_franchise_id;
  END IF;

  -- Audit trail
  INSERT INTO vonigo_credential_audit (franchise_id, action, performed_by)
  VALUES (p_franchise_id, CASE WHEN v_existing IS NULL THEN 'created' ELSE 'updated' END, 'n8n-settings');

  RETURN v_secret_name;
END;
$function$
;

CREATE TRIGGER trg_campaigns_updated BEFORE UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_crew_members_updated BEFORE UPDATE ON public.crew_members FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_updated_at_cpl BEFORE UPDATE ON public.customer_price_lists FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER estimates_updated_at BEFORE UPDATE ON public.estimates FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER feedback_updated_at_trigger BEFORE UPDATE ON public.feedback FOR EACH ROW EXECUTE FUNCTION update_feedback_updated_at();

CREATE TRIGGER trg_sign_rewards_updated BEFORE UPDATE ON public.sign_rewards FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_sign_sessions_updated BEFORE UPDATE ON public.sign_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_yard_signs_updated BEFORE UPDATE ON public.yard_signs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.crew_members ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.customer_price_lists ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.estimates ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.franchises ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.job_plans ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sign_credits ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sign_rewards ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sign_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sign_status_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.tools ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.vonigo_credential_audit ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.vonigo_credentials ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.yard_signs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select campaigns" ON public.campaigns AS PERMISSIVE FOR SELECT TO public USING (true);

CREATE POLICY "delete campaigns" ON public.campaigns AS PERMISSIVE FOR DELETE TO public USING (true);

CREATE POLICY "update campaigns" ON public.campaigns AS PERMISSIVE FOR UPDATE TO public USING (true);

CREATE POLICY "insert campaigns" ON public.campaigns AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "delete crew_members" ON public.crew_members AS PERMISSIVE FOR DELETE TO public USING (true);

CREATE POLICY "update crew_members" ON public.crew_members AS PERMISSIVE FOR UPDATE TO public USING (true);

CREATE POLICY "insert crew_members" ON public.crew_members AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "select crew_members" ON public.crew_members AS PERMISSIVE FOR SELECT TO public USING (true);

CREATE POLICY "read customer price lists" ON public.customer_price_lists AS PERMISSIVE FOR SELECT TO public USING (true);

CREATE POLICY "insert customer price lists" ON public.customer_price_lists AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "update customer price lists" ON public.customer_price_lists AS PERMISSIVE FOR UPDATE TO public USING (true);

CREATE POLICY "delete customer price lists" ON public.customer_price_lists AS PERMISSIVE FOR DELETE TO public USING (true);

CREATE POLICY "delete estimate" ON public.estimates AS PERMISSIVE FOR DELETE TO public USING (true);

CREATE POLICY "insert estimate" ON public.estimates AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "update estimate" ON public.estimates AS PERMISSIVE FOR UPDATE TO public USING (true);

CREATE POLICY "select estimate" ON public.estimates AS PERMISSIVE FOR SELECT TO public USING (true);

CREATE POLICY feedback_read_own ON public.feedback AS PERMISSIVE FOR SELECT TO public USING (true);

CREATE POLICY feedback_insert_anon ON public.feedback AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "read franchises" ON public.franchises AS PERMISSIVE FOR SELECT TO public USING (true);

CREATE POLICY "read invite by token" ON public.invites AS PERMISSIVE FOR SELECT TO public USING (true);

CREATE POLICY "create invites" ON public.invites AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "update invite" ON public.invites AS PERMISSIVE FOR UPDATE TO public USING (true);

CREATE POLICY job_plans_all ON public.job_plans AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);

CREATE POLICY "create profile" ON public.profiles AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "update profile" ON public.profiles AS PERMISSIVE FOR UPDATE TO public USING (true);

CREATE POLICY "read profiles" ON public.profiles AS PERMISSIVE FOR SELECT TO public USING (true);

CREATE POLICY "delete profile" ON public.profiles AS PERMISSIVE FOR DELETE TO public USING (true);

CREATE POLICY "select sign_credits" ON public.sign_credits AS PERMISSIVE FOR SELECT TO public USING (true);

CREATE POLICY "insert sign_credits" ON public.sign_credits AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "update sign_credits" ON public.sign_credits AS PERMISSIVE FOR UPDATE TO public USING (true);

CREATE POLICY "delete sign_credits" ON public.sign_credits AS PERMISSIVE FOR DELETE TO public USING (true);

CREATE POLICY "update sign_rewards" ON public.sign_rewards AS PERMISSIVE FOR UPDATE TO public USING (true);

CREATE POLICY "delete sign_rewards" ON public.sign_rewards AS PERMISSIVE FOR DELETE TO public USING (true);

CREATE POLICY "select sign_rewards" ON public.sign_rewards AS PERMISSIVE FOR SELECT TO public USING (true);

CREATE POLICY "insert sign_rewards" ON public.sign_rewards AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "select sign_sessions" ON public.sign_sessions AS PERMISSIVE FOR SELECT TO public USING (true);

CREATE POLICY "delete sign_sessions" ON public.sign_sessions AS PERMISSIVE FOR DELETE TO public USING (true);

CREATE POLICY "update sign_sessions" ON public.sign_sessions AS PERMISSIVE FOR UPDATE TO public USING (true);

CREATE POLICY "insert sign_sessions" ON public.sign_sessions AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "insert sign_status_events" ON public.sign_status_events AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "delete sign_status_events" ON public.sign_status_events AS PERMISSIVE FOR DELETE TO public USING (true);

CREATE POLICY "select sign_status_events" ON public.sign_status_events AS PERMISSIVE FOR SELECT TO public USING (true);

CREATE POLICY "update sign_status_events" ON public.sign_status_events AS PERMISSIVE FOR UPDATE TO public USING (true);

CREATE POLICY "read tenants" ON public.tenants AS PERMISSIVE FOR SELECT TO public USING (true);

CREATE POLICY tools_all ON public.tools AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);

CREATE POLICY "update yard_signs" ON public.yard_signs AS PERMISSIVE FOR UPDATE TO public USING (true);

CREATE POLICY "delete yard_signs" ON public.yard_signs AS PERMISSIVE FOR DELETE TO public USING (true);

CREATE POLICY "insert yard_signs" ON public.yard_signs AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "select yard_signs" ON public.yard_signs AS PERMISSIVE FOR SELECT TO public USING (true);
