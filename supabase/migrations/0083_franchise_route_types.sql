-- Per-franchise route classification (owner-set, CrewLogic-side source of truth).
-- Vonigo's routeTypeID is stable-ish (109=Estimate, 102=Junk Removal Only, 105=Reserve/Reschedule,
-- 112=Dispatch, 1=Regular, 101=Dumpster, 104=Pickup, 108=All) but franchises type routes
-- inconsistently, so the owner classifies each route here and OUR value wins for filtering/grouping
-- (Estimate Costing scoping, dispatch board grouping). One row per (tenant, Vonigo routeID), upserted.
create table if not exists public.franchise_route_types (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  franchise_id         uuid not null,
  vonigo_route_id      text not null,
  route_name           text,
  route_abbr           text,
  vonigo_route_type_id integer,                 -- what Vonigo says (for reference / pre-fill default)
  crewlogic_type       text not null,           -- estimate | junk | reserve | dispatch | other
  updated_by           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, vonigo_route_id)
);

alter table public.franchise_route_types enable row level security;
-- Edge-function/service-role access only (no public policy).

create index if not exists franchise_route_types_franchise_idx on public.franchise_route_types (franchise_id);

comment on table public.franchise_route_types is
  'Owner-set route classification per franchise (Estimate/Junk/Reserve/Dispatch/Other). CrewLogic value is authoritative over Vonigo routeTypeID. Read/written via crewlogic-dispatch (service role). Drives estimate-route scoping + dispatch board grouping.';
