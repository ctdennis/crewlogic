-- 0012: estimate_charges — Phase 1 of moving line items out of the estimates.payload JSON blob.
-- ADDITIVE ONLY: creates the table + RLS. No app code reads or writes it yet — that comes in later
-- phases (backfill → dual-write → cut over reads). See docs/plan-estimate-charges-normalization.md.
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0012_estimate_charges.sql
-- Apply to prod: gated, at promotion.
--
-- Design: one row per charge. The row carries the COMPLETE original charge object in `data` (lossless
-- — the frontend gets back exactly what it wrote: photos[], Vonigo priceItemID/taxID, AI analysis,
-- etc.), plus a few PROMOTED columns for reporting/indexing. Storing charges as rows is what makes a
-- status change (or any estimate-level save) structurally unable to blank the line items.

create table if not exists public.estimate_charges (
  id            uuid primary key default gen_random_uuid(),
  estimate_id   bigint not null references public.estimates(estimate_id) on delete cascade,
  franchise_id  uuid   not null references public.franchises(id),
  sequence      int    not null default 0,            -- display order within the estimate
  -- promoted/queryable columns (reporting + indexing). The authoritative copy is always `data`.
  type          text,                                 -- 'volume' | 'item' | surcharge/labor/etc.
  area          text,
  room          text,
  name          text,                                 -- item name (non-volume charges)
  description   text,
  qty           numeric,
  unit_price    numeric,
  truck_volume  numeric,                              -- volume charges (fraction of a truck)
  -- the full original charge object — lossless source of truth for the row:
  data          jsonb  not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists estimate_charges_estimate_idx  on public.estimate_charges (estimate_id, sequence);
create index if not exists estimate_charges_franchise_idx on public.estimate_charges (franchise_id);

-- RLS — mirror public.estimates exactly: franchise-scoped, authenticated only.
alter table public.estimate_charges enable row level security;
drop policy if exists estimate_charges_sel on public.estimate_charges;
drop policy if exists estimate_charges_ins on public.estimate_charges;
drop policy if exists estimate_charges_upd on public.estimate_charges;
drop policy if exists estimate_charges_del on public.estimate_charges;
create policy estimate_charges_sel on public.estimate_charges for select to authenticated
  using (franchise_id = public.current_franchise_id());
create policy estimate_charges_ins on public.estimate_charges for insert to authenticated
  with check (franchise_id = public.current_franchise_id());
create policy estimate_charges_upd on public.estimate_charges for update to authenticated
  using (franchise_id = public.current_franchise_id())
  with check (franchise_id = public.current_franchise_id());
create policy estimate_charges_del on public.estimate_charges for delete to authenticated
  using (franchise_id = public.current_franchise_id());
