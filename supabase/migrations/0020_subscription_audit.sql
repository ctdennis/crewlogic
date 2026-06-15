-- 0020_subscription_audit.sql — audit log for super-admin subscription/trial changes
create table if not exists public.subscription_audit (
  id uuid primary key default gen_random_uuid(),
  admin_email text not null,
  target_email text,
  target_franchise_id uuid,
  target_tenant_id uuid,
  action text not null,                 -- make_permanent | extend | set_end_date | cancel | reactivate
  old_status text,
  new_status text,
  old_trial_ends_at timestamptz,
  new_trial_ends_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.subscription_audit enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) may read/write this table.
-- Rollback: drop table if exists public.subscription_audit;
