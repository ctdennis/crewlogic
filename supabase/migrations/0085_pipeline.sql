-- Follow-up Pipeline (FW / task #28) — provider-agnostic core: one item table + a follow-up/touch table.
-- Only the SYNC ADAPTER is provider-specific (Vonigo in v1); this store, the touch/cadence engine, and the
-- UI are reused unchanged for the native build (source_provider discriminates). See docs/plan-pipeline.md.
-- Read/written via the crewlogic-pipeline edge fn (service role); RLS on, no public policy.

create table if not exists public.pipeline_items (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  franchise_id       uuid not null,
  type               text not null,              -- lead | unconverted_estimate | cancellation | ucb | case
  source_provider    text not null default 'vonigo',  -- adapter: vonigo | native | (future CRMs)
  source_object      text,                       -- workorder | client | case | native-estimate | ...
  source_external_id text not null,              -- the source system's id
  vonigo_link        text,
  -- denormalized item detail (queryable; no blob-cracking for the list)
  customer_name      text,
  phone              text,
  email              text,
  address            text,
  zip                text,
  amount             numeric,
  reason             text,                       -- cancel category/reason, case type
  detail             text,                       -- cancel comments, case narrative
  occurred_at        timestamptz,                -- created (lead) / service / cancel / opened (case)
  raw                jsonb not null default '{}'::jsonb,
  -- CRM workflow (CrewLogic-owned; PRESERVED across re-syncs — the sync never writes these)
  stage              text not null default 'new',  -- new | contacted | working | won | lost | resolved | dismissed
  assigned_to        text,
  next_action_at     timestamptz,                -- tickler the calendar/alerts fire on (= next open touch)
  cadence            text,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_synced_at     timestamptz,
  unique (tenant_id, type, source_external_id)
);

alter table public.pipeline_items enable row level security;
create index if not exists pipeline_items_franchise_stage_idx on public.pipeline_items (franchise_id, type, stage);
create index if not exists pipeline_items_next_action_idx     on public.pipeline_items (franchise_id, next_action_at);

comment on table public.pipeline_items is
  'Follow-up Pipeline items (leads/unconverted estimates/cancellations/UCBs/cases). Provider-agnostic core; source_provider selects the sync adapter. CRM fields (stage/assigned_to/next_action_at/cadence/notes) are CrewLogic-owned and preserved on re-sync. Via crewlogic-pipeline (service role).';

-- The reminder / calendar / drip engine: an ordered set of scheduled touches per item.
create table if not exists public.pipeline_touches (
  id               uuid primary key default gen_random_uuid(),
  pipeline_item_id uuid not null references public.pipeline_items(id) on delete cascade,
  due_at           timestamptz not null,        -- timestamptz (not date) so a timed appt can sync 1:1 to a calendar later
  channel          text,                         -- call | email | text | note
  status           text not null default 'scheduled',  -- scheduled | done | skipped
  auto             boolean not null default false,     -- reserved: a drip step CrewLogic could send automatically (not in v1)
  note             text,
  done_at          timestamptz,
  created_at       timestamptz not null default now()
);

alter table public.pipeline_touches enable row level security;
create index if not exists pipeline_touches_item_idx on public.pipeline_touches (pipeline_item_id);
create index if not exists pipeline_touches_due_idx  on public.pipeline_touches (due_at) where status = 'scheduled';

comment on table public.pipeline_touches is
  'Scheduled follow-up touches for a pipeline item — the calendar/reminder/cadence engine. due_at is timestamptz for calendar-sync readiness. Via crewlogic-pipeline (service role).';

-- ── ROLLBACK (manual): drop table pipeline_touches; drop table pipeline_items;
