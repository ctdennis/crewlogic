# Plan — Truck Setup: persistent truck table + drag/drop map ordering

Status: DRAFT — awaiting Owner approval before migration is written.
Owner: Charles Dennis · Created 2026-07-10 · Target: dev → prod

## Goal

Give each franchise a persistent list of its trucks (sourced from Linxup/Motive) and a
**drag/drop ordering** UI in Truck Setup. The green map-dot numbers then follow that order
(Truck "1" is always the same truck), instead of the current throwaway API-return sequence.

## Why

- Map dot numbers today = `i + 1` (order the telematics API happens to return) → meaningless,
  shifts day to day.
- Franchises name trucks every which way ("Ford 101", "T - 01", "Tundra"); we will NOT parse.
- Owner wants stable, owner-controlled numbering. Ordering now; per-truck custom label is a
  reserved fast-follow (column present, UI later).

## Data source (already exists — no new telematics plumbing)

`crewlogic-trucks` resolves the franchise's provider + token from Vault and returns:
`{ number, name, lat, lon, speed, heading, status, lastUpdate, make, model, year, vin, desc }`
plus top-level `provider`. We reuse this; we only add persistence for **order**.

## Schema — new table `franchise_trucks`

| column | type | notes |
|---|---|---|
| id | uuid pk | `gen_random_uuid()` |
| franchise_id | uuid not null | FK `franchises(id)` on delete cascade |
| truck_key | text not null | stable identity = **VIN if present, else telematics name** |
| name | text | last-seen telematics name (display) |
| vin | text | when the provider sends it |
| provider | text | `motive` \| `linxup` |
| sort_order | int not null default 0 | the drag/drop map order |
| active | boolean not null default true | false when no longer seen in the feed |
| created_at / updated_at | timestamptz default now() | |

- `unique (franchise_id, truck_key)`
- index on `(franchise_id, sort_order)`
- RLS: franchise-scoped, mirroring an existing per-franchise table (e.g. `tools`/`job_plans`) —
  franchise members read; owner writes.

## Flow

1. **Sync (on Truck Setup open):** edge action pulls trucks via `crewlogic-trucks` logic and
   upserts into `franchise_trucks` by `(franchise_id, truck_key)`. New trucks get
   `sort_order = max+1`, `active=true`; trucks no longer in the feed → `active=false` (kept,
   not deleted, so order survives a truck being offline). Returns the ordered list.
2. **Reorder (Save):** frontend sends the new ordered array of `truck_key`s; edge action writes
   `sort_order` = index per key.
3. **Map:** where trucks render, sort the array by `franchise_trucks.sort_order` (join on
   `truck_key`); unknown/new trucks fall to the end. Dot number = position + 1.

## Modal UX — Truck Setup ▸ "Map order"

- List of trucks, each a **draggable row**: drag handle · name · provider unit `number` ·
  active/stale chip.
- Drag to reorder → **Save** persists. Cancel discards.
- Empty/first-run: shows current feed trucks in API order, ready to arrange.
- (Reserved) inline-edit a custom display label — column exists; UI is a later pass.

## Build order

1. Migration `00NN_franchise_trucks.sql` → apply to **dev** first.
2. Edge action: extend `crewlogic-trucks` with `action: 'setupList'` (sync+return) and
   `action: 'reorder'` — OR a small `crewlogic-truck-setup`. (Lean: extend `crewlogic-trucks`.)
3. Frontend: Truck Setup modal (drag/drop) + wire the map sort by `sort_order`.
4. Test on dev (#90 Motive), then promote dev → main.

## Defaulted decisions (technical; will proceed unless Owner objects)

- **Identity key** = VIN when present, else telematics name.
- **Order applies to** the live truck map dots (+ the Trucks list panel).
- **v1 = ordering only**; custom per-truck label is a reserved fast-follow.

## Open for Owner

- OK to build on this schema/flow?
- Any change to identity key or where the ordering should apply?
