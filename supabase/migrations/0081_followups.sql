-- 0081_followups.sql
-- Vonigo follow-ups pipeline (task #28 / docs/plan-followups.md).
-- Turns the five Vonigo "loose ends" (unbooked leads, scheduling-cancels, unconverted estimates,
-- UCB, cases) into one actionable, dated pipeline.
--
-- TWO tables:
--   followups        — one row per follow-up item, keyed by its Vonigo source so re-sync UPDATES (never dups)
--   followup_events  — append-only audit log of every stage move + contact; source of truth for per-stage
--                      date tracking and the "today's activity" report.
--
-- Access: RLS enabled, NO permissive policy -> SERVICE-ROLE ONLY, mirroring route_truck_assignments (0074).
-- ALL reads/writes go through the crewlogic-followups* edge functions (service role, scoped by franchise_id).
-- The client NEVER touches these tables directly (direct-RLS-token-expiry lesson).
--
-- NOTE: `status` has NO CHECK constraint on purpose — pipeline stages are owner-tunable (New/Contacted/Won/
-- Lost/Snoozed today; an "Attempted" column may be added) and must not require a migration to change. `kind`
-- IS constrained: the five recognized types are fixed.

CREATE TABLE IF NOT EXISTS public.followups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise_id      uuid NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
  tenant_id         uuid,
  kind              text NOT NULL
                      CHECK (kind IN ('lead','cancel','unconverted_estimate','ucb','case')),
  source_type       text,                                  -- vonigo object: client | workorder | job | case
  source_id         text NOT NULL,                         -- Vonigo objectID / jobID
  customer_name     text,
  phone             text,                                  -- sms:/tel: + CSV export
  email             text,                                  -- mailto: + CSV export
  town              text,
  vonigo_created_at timestamptz,                           -- when the lead/cancel/etc. happened (drives "age")
  label             text,                                  -- kind context: cancel reason, estimate outcome, route name…
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,    -- raw reason codes, appt#, comments, address, etc.
  status            text NOT NULL DEFAULT 'new',           -- PIPELINE STAGE (owner-tunable; no CHECK by design)
  stage_since       timestamptz NOT NULL DEFAULT now(),    -- when the CURRENT stage began (full history in events)
  is_hot            boolean NOT NULL DEFAULT false,        -- priority flag -> reminders
  followup_at       timestamptz,                           -- next scheduled touch (scheduling + reminders)
  assigned_to       text,                                  -- profile email (optional)
  notes             text,
  last_touched_at   timestamptz,                           -- when a human last acted
  synced_at         timestamptz NOT NULL DEFAULT now(),    -- last time the sync saw it in Vonigo
  auto_resolved     boolean NOT NULL DEFAULT false,        -- closed by the system (re-booked/converted), not a human
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- anti-dup key: one row per Vonigo source object per kind per franchise -> upsert target
  UNIQUE (franchise_id, kind, source_id)
);

CREATE INDEX IF NOT EXISTS followups_status_idx     ON public.followups (franchise_id, status);
CREATE INDEX IF NOT EXISTS followups_kind_idx       ON public.followups (franchise_id, kind);
CREATE INDEX IF NOT EXISTS followups_followup_at_idx ON public.followups (franchise_id, followup_at)
  WHERE followup_at IS NOT NULL;                           -- reminders: due/overdue scans
CREATE INDEX IF NOT EXISTS followups_hot_idx        ON public.followups (franchise_id) WHERE is_hot;

ALTER TABLE public.followups ENABLE ROW LEVEL SECURITY;    -- no policy -> service-role only

-- Append-only audit + reporting feed: every stage move + contact is timestamped here.
CREATE TABLE IF NOT EXISTS public.followup_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  followup_id   uuid NOT NULL REFERENCES followups(id) ON DELETE CASCADE,
  franchise_id  uuid NOT NULL,
  event_type    text NOT NULL,                             -- stage_change | contact | note | snooze | hot | sync | auto_resolve | created
  from_stage    text,                                      -- (stage_change)
  to_stage      text,                                      -- (stage_change)
  channel       text,                                      -- (contact) sms | call | email
  detail        text,
  actor         text,                                      -- profile email, or 'system'
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS followup_events_item_idx  ON public.followup_events (followup_id, created_at);
CREATE INDEX IF NOT EXISTS followup_events_day_idx   ON public.followup_events (franchise_id, created_at);  -- today's-activity report

ALTER TABLE public.followup_events ENABLE ROW LEVEL SECURITY;  -- no policy -> service-role only

-- Reuse the shared updated_at trigger fn (same one route_truck_assignments/geocode_cache use).
DROP TRIGGER IF EXISTS trg_followups_updated ON public.followups;
CREATE TRIGGER trg_followups_updated
  BEFORE UPDATE ON public.followups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS public.followup_events;
--   DROP TABLE IF EXISTS public.followups;
