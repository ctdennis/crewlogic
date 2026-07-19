-- 0054_external_refs.sql
--
-- Provider identity mapping for every canonical entity.
-- Contract: docs/contract-jobs-schema.md §3.4 · Framework: docs/plan-integration-framework.md §6.1
--
-- ── D5: ADDING A CRM ADDS ROWS, NOT COLUMNS ──────────────────────────────────────────────
-- The tempting shortcut is a vonigo_job_id column on jobs, then a servicetitan_job_id column,
-- then one per provider per entity. That does not generalise and it puts provider concerns
-- inside the canonical model. One mapping table instead.
--
-- external_id is TEXT, never numeric: Vonigo ids are numeric strings, ServiceTitan uses int64,
-- and the next CRM may use a GUID. Storing text costs nothing and avoids a migration later.
--
-- external_version holds an etag / rowversion / updated_at for optimistic-concurrency conflict
-- detection where a provider offers one. ⚠ It will be NULL for ServiceTitan -- verified across
-- their OpenAPI specs, they expose NO version field anywhere. Conflict detection is therefore
-- unavailable for that provider, and the mitigation is ownership discipline (framework §4):
-- when the CRM owns the entity, write only user-requested deltas, never blind-overwrite a
-- whole record.
--
-- Additive only. Idempotent.

create table if not exists public.external_refs (
  id                uuid primary key default gen_random_uuid(),
  entity_type       text not null,
  crewlogic_id      uuid not null,
  franchise_id      uuid not null references public.franchises(id) on delete cascade,
  provider          text not null,
  external_id       text not null,
  external_version  text,
  last_synced_at    timestamptz,
  created_at        timestamptz not null default now(),

  -- One provider record maps to at most one canonical record.
  unique (entity_type, provider, external_id),
  -- ...and one canonical record has at most one id per provider.
  unique (entity_type, crewlogic_id, provider),

  constraint external_refs_entity_chk check (entity_type in (
    'job', 'appointment', 'customer', 'estimate', 'invoice', 'payment'
  ))
);

-- Reverse lookup: "what is this canonical record's id in provider X?"
create index if not exists external_refs_canonical_idx
  on public.external_refs (entity_type, crewlogic_id);

-- Sweep support: "everything from provider X for franchise Y, oldest sync first."
create index if not exists external_refs_sync_idx
  on public.external_refs (franchise_id, provider, last_synced_at nulls first);

-- NOTE: crewlogic_id is deliberately NOT a foreign key -- it is polymorphic across jobs,
-- job_appointments, customers, estimates and future invoices/payments. Referential integrity
-- is enforced by the writing adapter, and orphan rows are harmless (they resolve to nothing).
-- The alternative -- one mapping table per entity -- reintroduces exactly the column sprawl
-- this table exists to avoid.
