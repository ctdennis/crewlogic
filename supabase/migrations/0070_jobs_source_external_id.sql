-- 0070_jobs_source_external_id.sql
--
-- Batched-write scaling for the Vonigo mirror. The importer keyed idempotency on external_refs with a
-- per-row lookup + per-row insert/update, which capped at ~400 WorkOrders/call at prod latency and
-- timed out busy franchises (#31 Kevin — Queens + Long Island). Adding source_external_id (the provider
-- job/WO id) directly on jobs + job_appointments lets the importer BULK-UPSERT by it (thousands/call).
--
-- Backfill the column on EXISTING imported rows from external_refs BEFORE the unique constraint, so the
-- new bulk-upsert path matches them instead of inserting duplicates.
--
-- Additive, idempotent. Rollback at the bottom.

alter table public.jobs             add column if not exists source_external_id text;
alter table public.job_appointments add column if not exists source_external_id text;

-- Backfill existing imported rows from external_refs (provider='vonigo').
update public.jobs j set source_external_id = r.external_id
  from public.external_refs r
  where r.provider = 'vonigo' and r.entity_type = 'job' and r.crewlogic_id = j.id and j.source_external_id is null;
update public.job_appointments a set source_external_id = r.external_id
  from public.external_refs r
  where r.provider = 'vonigo' and r.entity_type = 'appointment' and r.crewlogic_id = a.id and a.source_external_id is null;

-- Unique per franchise. NULLs are distinct, so native rows (no source_external_id) are unaffected.
-- This constraint is the bulk-upsert onConflict target.
alter table public.jobs             add constraint jobs_franchise_source_ext_key             unique (franchise_id, source_external_id);
alter table public.job_appointments add constraint job_appointments_franchise_source_ext_key unique (franchise_id, source_external_id);

comment on column public.jobs.source_external_id is
  'Provider (Vonigo) job id for imported rows — the bulk-upsert key. NULL for native jobs.';
comment on column public.job_appointments.source_external_id is
  'Provider (Vonigo) WorkOrder id for imported rows — the bulk-upsert key. NULL for native.';

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- alter table public.jobs             drop constraint if exists jobs_franchise_source_ext_key;
-- alter table public.job_appointments drop constraint if exists job_appointments_franchise_source_ext_key;
-- alter table public.jobs             drop column if exists source_external_id;
-- alter table public.job_appointments drop column if exists source_external_id;
