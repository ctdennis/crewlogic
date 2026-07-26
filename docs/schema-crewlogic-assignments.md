# Schema Design — `route_truck_assignments` (FW-59, gate 2)

**Status:** DRAFT design — awaiting Owner approval (gate 2 of §11 in `docs/plan-truck-route-eta.md`). **No migration file written yet** — on approval this becomes `supabase/migrations/0074_route_truck_assignments.sql` and is applied to **dev** first.
**Owner:** Charles Dennis
**Backs:** `docs/contract-crewlogic-assignments.md`.

---

## 1. One new table. Everything else is reuse.

| Need | Source | New? |
|---|---|---|
| Authoritative truck↔route per day | **`route_truck_assignments`** (below) | **NEW** |
| Truck roster (dropdown + `truck_key`) | `franchise_trucks` (0035) | reuse |
| Yard origin address | `cost_settings.officeAddress` (UI relocates Costs→Account; no schema change) | reuse |
| Yard address → lat/lon | `geocode_cache` (0019, Census geocoder, service-role) | reuse |
| Route → jobs / windows / crew | Vonigo board (`crewlogic-dispatch`) + `job_source_snapshot` (0068) | reuse |
| First-arrival vehicle | `geofence_alerts` (0028/0043, `event_type='job_arrive'`, `vehicle_number`, `wo_id`) | reuse |
| `updated_at` maintenance | existing `set_updated_at()` trigger fn | reuse |

## 2. Proposed table (design — becomes 0074 on approval)

```sql
-- 0074_route_truck_assignments.sql
-- Authoritative truck↔route link per service day (FW-59).
-- JOIN TABLE on purpose: multiple rows per (franchise, date, route) are allowed so the
-- deferred multi-truck cases (plan §3) need NO migration later. Phase-1 UI writes ONE
-- truck per route (the `set` action prunes others — §4 below).
--
-- Access: RLS enabled, NO permissive policy -> service-role only, mirroring franchise_trucks.
-- ALL reads/writes go through the crewlogic-assignments edge function (service role, scoped
-- by franchise_id). The client NEVER touches this table directly (token-expiry lesson).

CREATE TABLE IF NOT EXISTS public.route_truck_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise_id    uuid NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
  service_date    date NOT NULL,                       -- franchise-local day (resolved via _shared/tz.ts)
  vonigo_route_id text NOT NULL,                        -- Vonigo route objectID
  route_name      text,
  truck_key       text NOT NULL,                        -- soft ref to franchise_trucks.truck_key; NO FK (see §3)
  source          text NOT NULL DEFAULT 'manual'        -- 'manual' | 'default' | 'inferred'
                    CHECK (source IN ('manual','default','inferred')),
  confidence      text,                                 -- set on 'inferred' (geofence auto-set)
  assigned_by     text,                                 -- profile email/id of the ops manager (manual)
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  UNIQUE (franchise_id, service_date, vonigo_route_id, truck_key)
);

CREATE INDEX IF NOT EXISTS rta_lookup_idx
  ON public.route_truck_assignments (franchise_id, service_date, vonigo_route_id);

ALTER TABLE public.route_truck_assignments ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_rta_updated ON public.route_truck_assignments;
CREATE TRIGGER trg_rta_updated
  BEFORE UPDATE ON public.route_truck_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS public.route_truck_assignments;
```

## 3. Design decisions (and why)

- **`uuid` PK, `franchise_id` only (no `tenant_id`).** Mirrors `franchise_trucks` — the scope for every action is the franchise; tenant is a join away if ever needed. Dropping `tenant_id` avoids a denormalized column that could drift. (Supersedes the `bigint`/`tenant_id` sketch in plan §4.)
- **Unique key `(franchise_id, service_date, vonigo_route_id, truck_key)` — not `(…, route)`.** Keying on the route alone would forbid multi-truck and force a Phase-2 migration. Keying on `+truck_key` keeps it a true join table (N trucks per route allowed) while still blocking a duplicate *same* truck on the same route/day. Phase-1's one-truck rule is enforced in the app, not the schema (§4).
- **No FK on `truck_key`.** A hard FK to `franchise_trucks(franchise_id, truck_key)` would block removing a truck that has history, or corrupt the record if a truck is renamed. History must survive roster churn, so `truck_key` is a **soft** reference. (The roster is validated at write time in the function, not by the DB.)
- **RLS enabled, no policies → service-role only.** Same as `franchise_trucks`/`geofence_alerts`. The client reads this only through `crewlogic-assignments` (service role, `franchise_id`-scoped) — never a direct RLS read (the fragile-token failure mode).
- **`ON DELETE CASCADE` on `franchise_id`.** Deleting a franchise removes its assignments; no orphans.
- **Reuse `set_updated_at()`** (same trigger `geocode_cache` uses) rather than maintaining `updated_at` in app code.

## 4. How the contract's writes map to the table

- **`set` (hard set, one truck/route)** — in a transaction: `DELETE` existing rows for `(franchise_id, service_date, vonigo_route_id)`, then `INSERT` the one row (`source='manual'`, `assigned_by`). `truck_key=null` → delete only (clears the route). This enforces the Phase-1 one-truck rule while leaving the schema multi-truck-ready. Intra-day swap keeps only the current truck (swap history is a deferred nicety, not lost across *days* — each day has its own rows).
- **`check` → autoset** — `INSERT` `source='inferred'` **only if no row exists** for that route+date (guarded). Never overwrites a `manual`/`default` row.
- **`check` → mismatch** — pure read + warning; **no write**.
- **`get` / `eta`** — read by `(franchise_id, service_date)`; a route with no row but a prior-day assignment surfaces as `source='default'` (the pre-fill), computed by the function, not stored until the ops manager confirms (which writes `manual`).

## 5. Yard origin — geocode reuse, no new schema

`origin: "yard"` resolves `cost_settings.officeAddress` → lat/lon through the **existing `geocode_cache`** (normalize address → `address_key` → hit; on miss, geocode via Census exactly as `crewlogic-todays-workorders` does, then cache). The cost-analysis routing (index.html ~21283/21434) already turns `officeAddress` into a point — gate-2 code work reuses that path. The Costs→Account settings move is **UI only**; `officeAddress` stays in `cost_settings`. No column added.

## 6. `schema.md` compliance

`CREATE TABLE IF NOT EXISTS` (+ `IF NOT EXISTS` index, `DROP TRIGGER IF EXISTS`); snake_case; rollback block included; constraint intent commented; no `DROP TABLE` of anything existing. Applied to **dev** first (via `dev-sql.sh` / `prod-write-sql.sh -f` for prod later), never straight to prod.

---

_On approval, gate 3 = write `0074_route_truck_assignments.sql` (this DDL) and apply to dev. Still no application code until the migration lands + is verified._
