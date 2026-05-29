-- 0004: per-capability provider seam on tenants (CL-SPEC-001 §3).
-- Replaces reliance on the coarse `crm_type` flag with three independent capability columns,
-- so a tenant can mix systems (e.g. HubSpot customers + native pricing) and new providers
-- (ServiceTitan/Salesforce) slot into ONE capability later with no schema change.
--
-- Defaults assume the SELF-SERVE end state: a newly signed-up company has no CRM, so a new
-- tenant row defaults to native pricing + native customers + no external submission. Existing
-- tenants are backfilled from their current `crm_type` so live behavior is byte-identical
-- (all production tenants are Junkluggers/vonigo today).
--
-- No CHECK constraint on the values on purpose — future providers (hubspot, salesforce,
-- servicetitan, …) must be addable without another migration.
-- Additive + idempotent.

alter table public.tenants add column if not exists pricing_source    text not null default 'native';
alter table public.tenants add column if not exists customer_source   text not null default 'native';
alter table public.tenants add column if not exists submission_target text not null default 'none';

-- Backfill existing rows from the legacy coarse `crm_type`. vonigo tenants → vonigo across all
-- three; anything else (crm_type 'none'/null) keeps the native/none column defaults.
update public.tenants
   set pricing_source    = 'vonigo',
       customer_source   = 'vonigo',
       submission_target = 'vonigo'
 where crm_type = 'vonigo';
