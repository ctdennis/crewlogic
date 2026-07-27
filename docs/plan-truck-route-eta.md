# Plan — Truck→Route Assignment + ETA / Late-Arrival Prediction

**Status:** APPROVED 2026-07-26 — Phase 1 build authorized. Proceeding contract-first (gate order §11).
**Owner:** Charles Dennis
**Next action:** Contract approved. Schema design drafted (`docs/schema-crewlogic-assignments.md`) → Owner approves schema → migration `0074` on dev → code, one gate at a time.
**Related:** `docs/plan-truck-crew-inference.md` (crew-infer, reused here), `docs/vonigo-dispatch-map-notes.md` (board + Vonigo field reference).

---

## 1. Goal

Give ops a proactive read on **which truck is on which route today** and **whether it will hit each job inside the scheduled appointment window** — stated in plain language, with a one-tap path to call the customer when it won't.

The core sentence this feature produces, per job:

> We anticipate **[Truck X]** to arrive at **[Job #]** for **[NAME]** in **[TOWN]** at **[TIME]**. This is **[within] / [outside]** the scheduled appointment window.
> _(when outside)_ Please contact customer at **[phone]** with your ETA.

- **[phone]** is a clickable `tel:` link.
- **[Job #]** is a clickable deep-link to the WorkOrder in Vonigo.
- Show the amount **early/late** (e.g. "18 min late"), not just within/outside.

## 2. Why we're close (what already exists — we assemble, not build)

| Piece | Status | Source |
|---|---|---|
| crew ↔ route ↔ job ↔ scheduled time | **Exists** | Vonigo WorkOrder Relations (`route`, `crew`) + fields `timeMin` (9082), `durationMin` (186); denormalized in `job_source_snapshot` |
| Truck live GPS | **Exists** | Motive/Linxup via `franchise_trucks` roster + live telematics |
| Truck arrival stream | **Exists** | `geofence_alerts` (`job_arrive`/`job_leave` per `vehicle_number` + `wo_id`) |
| Traffic-aware travel time | **Exists** | Google Distance Matrix (`crewlogic-route-disposal`, `crewlogic-estimate`); TomTom on the frontend measure feature |
| On-time-vs-late math | **Exists** | `_arrivalInfo` in `index.html` |
| Truck ↔ crew inference | **Exists** | `crewlogic-geofence-alerts` `crew-infer` |
| **Truck ↔ route (authoritative, per day)** | **MISSING — this plan** | Vonigo has no truck/resource field anywhere; must be created by us |

The single missing edge is **truck ↔ route**. Because crew↔route is already known from Vonigo, capturing truck↔route yields truck↔crew for free.

## 3. Scope

**Phase 1 (this plan) — internal-facing, no automated customer messaging:**
1. Ops manager **hard-sets** the truck for each route via a dropdown in the **first column** of the dispatch schedule.
2. Assignment is **persisted per `service_date`** (historical record from day one).
3. **Geofence mismatch warning:** if the first crew to arrive at a route's job is a *different* truck than the hard-set, **alert/warn** — do **not** auto-overwrite.
4. **ETA / late prediction** per remaining job: predicted arrival + within/outside the scheduled window + minutes early/late.
5. The **anticipated-arrival statement** (§1) with clickable phone + clickable job→Vonigo.
6. **Display** the above in three surfaces (§8).

**Explicitly deferred to a later phase (Owner decision #4):**
- *Splitting* one route's stops across trucks (each truck a different subset). **Co-located multi-truck — piggybacking + multi-truck jobs — is now Phase 1 (§5.2)** (schema already supports it — join table); only per-truck stop-splitting, which the Junkluggers patterns don't use, stays deferred. One truck on multiple routes is handled (each route is its own row).
- Automated proactive **customer** comms (auto-text/email). Phase 1 shows a human the phone to call; it does not send.
- Customer-facing live truck-tracking page.
- **Richer duration / capacity model.** A learned service-time model: base ~1.5 hr to fill a *whole* truck empty→full (a capacity number, not a per-job duration), modified by access difficulty (garage / storage-unit / curbside faster; inside / third-floor / attic / basement slower), calibrated against real geofence dwell (arrive→leave). Feeds sharper down-the-line predictions and the **dump-detour** prediction (truck fills before the next job → unplanned facility stop, using the Vonigo-charged volume on the completed job + the next job's estimate item list). May borrow from the n8n route-optimization routines, but we intend to **avoid that level of complexity** — keep it lightweight. **Data gap:** access difficulty isn't a clean field today (buried in the estimate situation/item list) — encoding it needs a captured access signal.

## 4. Data model (one new table)

> **Finalized design + rationale: `docs/schema-crewlogic-assignments.md` (authoritative).** The sketch below is superseded there — final shape is `uuid` PK, franchise-scoped (no `tenant_id`), unique on `(franchise_id, service_date, vonigo_route_id, truck_key)`.

```sql
-- route_truck_assignments — authoritative truck↔route link per service day.
-- Join table on purpose: multiple rows per (franchise, date, route) are allowed
-- so the deferred multi-truck cases need NO migration later. Phase-1 UI writes 1 row/route.
create table if not exists route_truck_assignments (
  id                bigint generated always as identity primary key,
  tenant_id         uuid not null references tenants(id),
  franchise_id      uuid not null references franchises(id),
  service_date      date not null,                 -- franchise-local day
  vonigo_route_id   text not null,                 -- Vonigo route objectID
  route_name        text,
  truck_key         text not null,                 -- matches franchise_trucks.truck_key
  source            text not null default 'manual',-- 'manual' | 'default' | 'inferred'
  confidence        text,                          -- for 'inferred' rows
  assigned_by       text,                          -- profile/email of the ops manager
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists rta_lookup
  on route_truck_assignments (franchise_id, service_date, vonigo_route_id);
```

- `truck_key` reconciles to `franchise_trucks` (`'vin:<VIN>'` or `'name:<name>'`).
- The table **is** the history (keyed by `service_date`). Fuels later actual-duration learning.
- Relational, not a JSON blob (per house rule).

## 5. Assignment UX — hard-set + mismatch warning (Owner decision #3)

- **First column** of the dispatch schedule gets a **Truck** dropdown per route row, populated from `franchise_trucks` (active trucks for the franchise).
- **Pre-fill (convenience, not authority):** default the dropdown to the **most recent prior `service_date`'s assignment** for that route, marked `source='default'`. The ops manager's pick promotes it to `source='manual'` — the **hard set**, which is authoritative.
- On change → write `route_truck_assignments` (upsert for that route+date).
- Next to the dropdown, show the assigned truck's **live status dot** (the moving / parked / stale / unplugged colors already shipped) so the board and trucks-map read as one system.
- **Geofence at first arrival — two modes:**
  - If an assignment **exists** (hard-set or default) and the first arriving truck **differs** → raise a **warning** (§8 alerts rail + board flag). It **does not** overwrite — ops decides. *(Owner decision #3.)*
  - If **no** assignment exists for that route today → **auto-set** it from the arriving truck (`source='inferred'`) and **notify**. Graceful fallback for franchises that don't pre-assign in the morning.
  - If it matches → confirmed, no action.

### 5.1 Crew ↔ truck — how it resolves (franchises vary)

Crew is entered in Vonigo the night before at some franchises, the morning-of at others — so the plan does **not** assume crew↔route is known in advance. It degrades gracefully:
- Truck↔crew is *derived* by joining **route↔truck** (this feature) to **route↔crew** (Vonigo), on the route — no separate crew capture.
- Vonigo crew populated in advance **+** truck hard-set → truck↔crew known **before roll-out**.
- Vonigo crew not in yet, or no truck set → resolves at **first arrival**: the geofence event sets/confirms the truck, and the job's Vonigo crew (whenever entered) completes the link.
- No crew-on-truck roster in Phase 1 (deferred) — this is pure derivation.

### 5.2 Multi-truck routes — co-located, one shared timeline (Phase 1)

Two real patterns, both **co-located** (the trucks travel and arrive **together**), so neither splits a route's stops across trucks:
- **Piggybacking** — two trucks, two drivers (one each, e.g. Carter in Truck 1 + Adyn in Truck 2) run the **same** route together. When one fills they keep collecting into the other, so they skip the transfer-station trip until **both** are full — more jobs, less unloading time. The route's crew still reads as the two drivers; they just have two trucks.
- **Multi-truck job** — a large crew + multiple trucks sent to one route / big job (e.g. **sfrazza**).

Handling: a route may carry **N trucks**, all sharing **one prediction timeline** — predict the route once (§6) and attach every assigned truck to it; **do not split stops across trucks.** Live ETA anchors on the **trailing** truck (most conservative). Assignment (§5) lets ops put more than one truck on a route; the geofence check is **set-based** (an arriving truck in the assigned set = match; one not in it = mismatch warning; none assigned = auto-set the arriving truck(s)).

**Still deferred:** *splitting* one route's stops across trucks (each truck a different subset) — the Junkluggers patterns above don't do this. **Phase-2 capacity note:** piggybacked trucks are **pooled capacity** — the dump-detour model must treat them as combined volume before a transfer-station trip is needed (that's the whole point of piggybacking).

### 5.3 One truck across sequential routes (combined-then-split)

A truck can run more than one route in a day. Real case: a large crew + two trucks share a big first job on **Route A** (~4 h), then split — **Truck 1 → Route B**, **Truck 2 → Route C** — for the afternoon. In Vonigo these are distinct routes (A/B/C); the trucks map Truck 1→A+B, Truck 2→A+C.

- **Storage + assignment already handle it.** The per-route replace-set (§5) is independent per route, so the same truck belongs to multiple routes' sets (Truck 1 on A and on B are separate rows). The multi-select must therefore **NOT** lock a truck to a single route.
- **Day-start prediction (Phase 1) flags it, doesn't chain it.** The per-route walk from the yard is right for a truck's *first* route but optimistic for its *second* (Route B doesn't start fresh from the yard — Truck 1 is coming off A's 4-hour job). Phase 1 **detects a truck assigned to 2+ routes and flags the affected routes** ("Truck 1 also on Route A — assumes a fresh start") rather than silently mispredicting.
- **Live prediction handles it for free.** GPS-anchored, so Truck 1's afternoon Route-B ETA already reflects it still being at Route A. The gap is only in the pre-roll day-start view.
- **Phase-2 refinement — per-truck DUTY chaining:** model the prediction unit as each truck's *ordered job list across all its routes* (yard → Route A's jobs → Route B's jobs). This unifies every case — single, piggyback (shared duty), sequential (chained duty) — and predicts the afternoon routes from where the morning actually finished.

**UI-state-preservation guardrail (mandatory, per house rule):** the board re-renders via `innerHTML`. The dropdown write must **not** blow away scroll position or an open dropdown. Update the one row/cell in place by stable id (reuse the known-good `_paintFacSave` / surgical-repaint patterns), never re-render the whole board on save.

## 6. Prediction engine — two modes (Owner decision #2 — time + late)

Server-side, service-role, scoped by `franchiseInternalID` (never a direct RLS read — token-expiry lesson). Same engine, two starting conditions.

### 6a. Day-start feasibility (before anyone rolls) — Phase 1, ops-tunable
Nothing is moving yet, so this walks the route on scheduled times + drive times. Because scheduled windows are unreliable in **both** directions — crews often pick up time, but a heavy day (hard-access, third-floor, attic) runs long — the ops manager sets a **duration dial** centered on the schedule: a multiplier on each job's scheduled duration spanning both ways, e.g. **60% (40% faster) → 100% (as scheduled) → 140% (40% longer)** in 10-point steps (radio or dropdown). `effective service = durationMin × multiplier`; the walk is then: yard → drive to job 1 → effective service → drive to job 2 → … checking each job's arrival against its window.
- **The real value is the sensitivity sweep, both ways.** Dial toward *faster*: a route still red at 60% has impossible *geometry* (drives alone don't fit the windows); one red at 100% but clear at 80% is just *tight*, doable if they hustle. Dial toward *slower*: a **stress test** — "if today runs heavy, which routes break?" — surfaced before anyone rolls.
- **Global multiplier, not per-job** (round 1) — one dial for the day. Per-job / access-based durations are the Phase-2 learned model (§3), which will eventually pre-set this dial from measured dwell history.
- Applies to **day-start only** — the live prediction (§6b) is GPS-anchored and needs no dial. Still **labeled a guesstimate**: a sanity check, not a promise.
- **Runs for any date, from the parking origin, truck-agnostic.** The walk starts every route at the franchise yard/parking location (not live GPS) and doesn't need a truck assigned — so it works for a **future** `serviceDate` too ("how will tomorrow play out?"), and doubles as how we test the engine against real upcoming routes without waiting for a live day. A future board reflects only jobs booked so far, so it firms up as the day nears.
- **Default / persistence:** default **100% (as scheduled)** on first use, then remember the franchise's last pick — *(confirm.)*

### 6b. Live prediction (during the day) — Phase 1, the accurate number
Anchored on the truck's **live GPS**, which is what makes it self-correct — leave a job early and the next ETA moves earlier; sit past the scheduled stop and it slides later, automatically, no duration guess needed.
```
next_stop = the job the truck is at or heading to
travel    = distanceMatrix(truck live GPS -> next_stop.latlon)   # traffic-aware
eta       = now() + travel   # if still parked at prior job, + time until it leaves (geofence job_leave)
window    = [timeMin, timeMin + durationMin]   (§7)
status    = within / early by (start - eta) / late by (eta - end)
```
- **Next stop is the confident number.** **Downstream** stops stay light: carry the current *measured* running delta forward, or show their scheduled window until the truck is one stop away. We do **not** compound scheduled durations — they're padded, crews usually pick up time, and compounding cries wolf.
- **Done detection:** drop a job when Vonigo status/label says completed **or** a `job_leave` follows its `job_arrive`.
- **Cadence (tie to promise):** recompute on a ~5-min ops tick, any geofence arrive/leave, or meaningful truck movement; skip when nothing moved and nothing closed — controls Distance Matrix cost.
- **Travel provider:** Google Distance Matrix (already server-side); TomTom optional for parity.

## 7. Scheduled appointment window (settled)

Window **start** = `timeMin` (field 9082); window **end** = `timeMin + durationMin` (field 186). "Within / outside" = predicted arrival vs `[timeMin, timeMin + durationMin]`. No separate arrival-window setting needed.

Note: in Phase 1 we do **not** treat `durationMin` as a modeled service time to chain later stops — live mode (§6b) anchors on GPS, day-start mode (§6a) uses the scheduled stop times directly. `durationMin` is used only as the window end here. Learned service times are the Phase-2 richer model (§3).

## 8. Where to display it (settled — Owner decision #2)

Three surfaces, each with a distinct job:

1. **Dispatch board (at-a-glance, route roll-up):** the new first column shows truck + live dot; each route row gets a **route-level** chip = the worst stop. Before roll-out it's the **day-start feasibility** chip, driven by the §6a duration dial (a small radio/dropdown control on the board — chips recompute as ops changes the multiplier); once trucks move it becomes the **live** on-time/late chip (green within / amber early / red late + minutes). Ops oversight view.
2. **Live Alerts rail (push):** late-arrival warnings and truck-mismatch warnings surface as they happen.
3. **Map job popup (per-job, the full statement):** clicking a job shows the §1 sentence verbatim for that job — anticipated arrival, within/outside, minutes early/late, and (when outside) the clickable `tel:` phone + clickable job→Vonigo link.

## 9. Plumbing to verify before building the auto/warn layer

- **Truck identity reconciliation:** the truck settings screen already aligns truck **number ↔ name** (`franchise_trucks`), so the dropdown label ↔ roster identity is handled. Remaining check: confirm `geofence_alerts.vehicle_number` resolves through that same identity so mismatch detection and auto-set compare the right truck. Small verification pass, Phase 1.
- **Vonigo job deep-link:** confirm/reuse the existing Vonigo WorkOrder URL pattern for the clickable **[Job #]**; construct from `wo_id` if none exists.
- **Customer phone source:** confirm the phone comes through on the job object (Vonigo contact) for the `tel:` link.
- **Parking/yard origin — reuse the existing field, don't add one.** The address already exists: the **Office Address** input (`settingsOfficeAddress`, index.html:1886) stored as `cost_settings.officeAddress`, currently under **Settings → Costs**. This is the truck base/departure point — for #90 it should hold the **parking** address *2 County Road* (not the office-of-record *11 Wagon Trail*). Day-start geocodes it to lat/lon for the origin. **Phase-1 UX (owner):** relocate this input from Settings → Costs to the **main Account settings**. Gate-2 checks: confirm #90's stored value + geocode it; confirm the other `officeAddress` consumers (cost-analysis routing, index.html ~21283/21434) want this same truck-base origin (they should — trucks depart the yard, not the office of record).

## 10. Component checklist (all additive)

**Migrations**
- `NNNN_route_truck_assignments.sql` — the table in §4.
- **No new location field** — reuse the existing `cost_settings.officeAddress` (the Office Address input) as the truck-base/parking origin; geocode it to lat/lon. **UI-only change:** relocate that input from Settings → Costs to the main Account settings (owner). See §9.

**Edge function** — a **new `crewlogic-assignments`** (rationale in §13-Q3), service-role, scoped by franchise, actions:
- `get` — assignments for (franchise, service_date), to render the dropdowns + status.
- `set` — upsert one route's truck (the hard set).
- `eta` — the §6 prediction engine, both modes (day-start feasibility §6a + live §6b; reuses the Distance Matrix helper from `crewlogic-route-disposal`).
- `check` — on first `job_arrive` per route, compare arriving vehicle to the assignment → warn-on-mismatch or auto-set-if-empty (§5). Reads `geofence_alerts` as data; reuses `crew-infer` aggregation.

Leaves the existing `crewlogic-geofence-alerts` function (and the alerts rail) untouched.

**`index.html`** (preserve everything per regression guard; edits additive)
- Board: first-column Truck dropdown + live dot + on-time/late chip (in-place update, no full re-render on save).
- Map job popup: the §1 statement + clickable phone + job→Vonigo.
- Live Alerts rail: late + mismatch warnings.

## 11. Build sequence (contract-before-code)

1. **API contract** MD sketch (endpoints, request/response, error shape) — Owner glance.
2. **Migration** `route_truck_assignments` → apply to **dev** (`dev-sql.sh` / `prod-write-sql.sh -f` for prod later).
3. **Edge functions** (assignment CRUD → ETA → mismatch), deploy to **dev** ref.
4. **`index.html`** UI on the `dev` branch → `dev.crewlogic.pages.dev`.
5. **Test** on dev (§12), then promote (dev→main) per the standard gated flow.

## 12. Test discipline (MEDIUM — data write + board re-render + prediction)

Right-sized manual script at dev-promotion (Owner-executed). Because this both **saves** (assignment) and **re-renders** the board, the plan MUST include a **mid-interaction** step: change a truck dropdown while scrolled ~30 rows down with another dropdown open → assert the board stays put, no blank flash, and the value persisted (read back from `route_truck_assignments`). Plus: verify a known late job shows "outside window + N min late" and the clickable phone/Vonigo links resolve.

## 13. Decisions (settled)

1. **Window** (§7): `[timeMin, timeMin + durationMin]`. ✔
2. **Display granularity** (§8): per-job in the map popup, route roll-up on the board. ✔
3. **Assignment endpoint — Q3:** a **new `crewlogic-assignments`** function, not folded into `crewlogic-geofence-alerts`. ✔ Rationale: `geofence-alerts` is a *read / aggregation* service over past events (alerts rail, `crew-infer`) and sits on the fragile RLS path; this work is a *write* over a new table plus a *forward-looking* ETA forecast — a different responsibility. Separating keeps each function's job clear, and iterating on ETA/assignment never redeploys (and risks regressing) the alerts rail. The mismatch check reads `geofence_alerts` as data, so it doesn't need to live inside that function.

No open blockers. Truck-identity reconciliation, the Vonigo job deep-link, and the customer-phone source (§9) are verification tasks inside Phase 1, not gates on approval.

---

_On approval, Phase 1 items are added to `.HUB/Hub.md` with status/owner/next-action, and the build starts on `dev`._
