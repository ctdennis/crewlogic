-- 0024_dispatch_audit.sql — durable audit log for the Manage Jobs voice dispatcher.
-- Every AI-driven Vonigo write (move / cancel) writes one row here. Required by the
-- voice-dispatch plan's safety section before the feature touches the real Vonigo in prod.
create table if not exists public.dispatch_audit (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  franchise_id uuid,                    -- internal franchises.id
  franchise_external_id text,           -- e.g. '90'
  actor_email text,                     -- who issued the command (may be null)
  action text not null,                 -- move | cancel
  command_text text,                    -- the raw voice/text command, if available
  resolved jsonb,                       -- resolved IDs: {woID|jobID, route, dayID, startTime, ...}
  fields_written jsonb,                 -- the exact Vonigo payload/Fields sent
  vonigo_errno integer,                 -- Vonigo errNo from the write response
  success boolean not null default false,
  dry_run boolean not null default false,
  result jsonb,                         -- full/summarized Vonigo response
  created_at timestamptz not null default now()
);
create index if not exists dispatch_audit_franchise_idx on public.dispatch_audit (franchise_id, created_at desc);
create index if not exists dispatch_audit_tenant_idx on public.dispatch_audit (tenant_id, created_at desc);
alter table public.dispatch_audit enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) may read/write this table.
-- The dispatcher edge fn runs with the service role; the browser anon key cannot touch it.
-- Rollback:
--   drop index if exists public.dispatch_audit_tenant_idx;
--   drop index if exists public.dispatch_audit_franchise_idx;
--   drop table if exists public.dispatch_audit;
