-- Estimate Costing (reverse-estimate) saved margin snapshots.
-- One CURRENT row per (tenant, Vonigo jobID) — upserted on save (latest wins). Read/written ONLY through the
-- crewlogic-ny-estimate edge function (service role); no public policy. Reopening a saved job restores from the
-- payload snapshot and SKIPS the AI, so re-opens cost no quota/spend.
create table if not exists public.estimate_costings (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  franchise_id    uuid not null,
  vonigo_job_id   text not null,
  vonigo_quote_id text,
  -- denormalized summary for list/report/write-back without cracking the payload
  client_name     text,
  job_address     text,
  zip             text,
  total_cuyd      numeric,
  trucks          numeric,
  price           numeric,
  adj_net         numeric,
  cost_total      numeric,
  margin          numeric,
  margin_pct      numeric,
  -- full point-in-time snapshot: rooms[], adjustments[], cost inputs, distances, spend, photo refs
  payload         jsonb not null default '{}'::jsonb,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, vonigo_job_id)
);

alter table public.estimate_costings enable row level security;
-- Intentionally NO policy: access is edge-function/service-role only (service role bypasses RLS).

create index if not exists estimate_costings_franchise_idx on public.estimate_costings (franchise_id);

comment on table public.estimate_costings is
  'Saved Estimate Costing (reverse-estimate) margin snapshots — one current row per (tenant_id, vonigo_job_id), upserted latest-wins. Read/written only via the crewlogic-ny-estimate edge function (service role). payload holds the full rooms/adjustments/cost/distances snapshot so reopening skips the AI.';
