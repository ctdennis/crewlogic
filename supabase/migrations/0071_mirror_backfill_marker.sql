-- 0071_mirror_backfill_marker.sql
--
-- DR mirror deep-backfill progress marker. A nightly cron walks each Vonigo franchise's history further
-- back (a few weeks/night, skip-contacts) until it reaches 3 months, tracked by mirror_backfilled_days.
-- This ALSO handles auto-onboarding: a newly-connected franchise starts at the default and the same
-- nightly cron catches it up — no onboarding-specific trigger needed (the 15-min sync already covers its
-- near-term the moment it has Vonigo creds).
--
-- Default 3: the 15-min sync covers days 0-2 back (+7 forward) WITH contacts, so the deep pass starts at
-- day 3 (skip-contacts, name-only — old jobs don't need a callable number, and non-overlap avoids nulling
-- the recent contacts). Existing Vonigo franchises already have ~14 days of recent backfill, so they
-- start their deep pass at 14.
--
-- Additive, idempotent. Rollback at the bottom.

alter table public.franchises add column if not exists mirror_backfilled_days integer not null default 3;

update public.franchises f set mirror_backfilled_days = 14
  from public.tenants t
  where t.id = f.tenant_id
    and (t.submission_target = 'vonigo' or t.pricing_source = 'vonigo')
    and f.mirror_backfilled_days = 3;

comment on column public.franchises.mirror_backfilled_days is
  'DR mirror: days of Vonigo history the nightly deep-backfill has reached (caps at 90 = 3 months). New franchises default 3 (the 15-min sync covers 0-2). Reset to 3 to re-run the deep backfill.';

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- alter table public.franchises drop column if exists mirror_backfilled_days;
