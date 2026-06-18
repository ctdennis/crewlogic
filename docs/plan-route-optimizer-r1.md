# Route Optimizer — Round 1 Spec (Disposal-Stop Recommender)

**Status:** Draft for owner approval · **Created:** 2026-06-18
**Owner:** charles.dennis@junkluggers.com
**Related:** Hub "Route Optimizer re-architecture" row · memory `route-optimizer-rearchitecture` · `docs/plan-payments.md`

The full Route Optimizer is single-tenant (#90-only, n8n + owner's Google Sheet). Round 1 is a
**slimmed, multi-tenant disposal-stop recommender** built on the existing per-franchise
`cost_settings` + cost engine — no n8n, no Google Sheet, no geofences.

---

## 1. What Round 1 does

For a single job: given **where the truck is now**, **where the job is**, and the franchise's
**disposal sites**, compute — for each disposal site — how long it takes and how much it costs
(disposal fee + crew wait-time + drive/fuel) to dispose of what's in the truck, then surface the
**least-cost** and **least-time** options as a recommendation.

**Out of scope for R1:** recycling/donation sites, multi-job day routing/sequencing, geofence-derived
wait-times (use the manual per-site wait time already in settings), truck-load/volume packing.

---

## 2. Gating

- **Available ONLY if the franchise has Motive OR Linxup connected** (the recommendation starts from
  the truck's live position). Gate on the existing per-franchise telematics status (`getTelematics`).
- In the payments matrix: **Pro+ tier AND telematics connected.**
- The existing `#routerCard` (currently hard-gated to #90) is re-gated to telematics-connected; the
  old n8n route call (`crewlogic-route`) is NOT used by R1.

---

## 3. Inputs (all already available)

| Input | Source |
|---|---|
| Truck live position | telematics (`crewlogic-trucks`, per-franchise) |
| Job location | the estimate / work order address (geocoded) |
| Candidate disposal sites | `cost_settings.disposalSites[]` (address + per-site rate) |
| What's in the truck (tons) | **CY ÷ 16** (16 CY = 1 ton, fixed); CY from the estimate volume / `truckCY` |
| Per-site rate ($/ton) | `getDisposalCost(address)` (existing per-site cost; default `cs.disposalCost`) |
| Wait time per site | `cost_settings.disposalWait` (default 15 min) — manual, NOT geofence |
| Crew labor rate | `cost_settings.crewRate` |
| Fuel | `cost_settings.MPG`, `cost_settings.fuelCost` |
| Leg distances/times | Google Distance Matrix (`crewlogic-estimate` `calcDistances`) |

**Weight rule (locked):** `tons = CY / 16`. A full 16-CY truck = 1 ton (franchise average, accepted
as good enough). A franchise with a different `truckCY` → full truck = `truckCY / 16` tons.

---

## 4. New data — per disposal site (`cost_settings.disposalSites[]`)

Add to each disposal site:
- **rate** ($/ton) — already present as the per-site cost.
- **minimumType**: `none` | `weight` | `dollar`
- **minimumValue**: number (tons if `weight`, dollars if `dollar`; ignored if `none`)

Settings UI (Cost tab → disposal site row): a small **Minimum** selector (None / Weight / $) + value.

---

## 5. Cost & time math (per candidate site)

Let `W` = tons in truck (`CY/16`), `R` = site rate ($/ton).

**Disposal fee:**
- `none` → `W × R`
- `weight` (min `M` tons) → `max(W, M) × R`
- `dollar` (min `$D`) → `max(W × R, D)`

(Above any minimum, always prorated by actual weight — no whole-ton round-up.)

**Time** = drive(truck → job) + (job service time, constant across sites) + drive(job → site)
+ `disposalWait` [+ optional return leg — see open Q]. Drive legs via Distance Matrix.

**Total cost** = disposal fee + crew labor (`crewRate × (driveTime + disposalWait)`) + fuel
(`miles / MPG × fuelCost`).

**Recommendation:** rank candidate sites; return the **least-cost** site and the **least-time**
site (may be the same), each with its cost + time breakdown.

---

## 6. Architecture (off n8n)

- **New edge function** (e.g. `crewlogic-route-disposal`): takes franchiseID + job address + truck
  position + load CY; reads `cost_settings` (service role), calls Distance Matrix for the legs,
  applies the math above, returns ranked sites + the two recommendations. Reuses the existing
  cost-engine logic (index.html ~19179–19404) ported server-side.
- **No new tables for R1** — disposal sites + costs live in `cost_settings` (JSONB), distances are
  computed live, truck position is live telematics. (Tables come later for accumulated geofence
  wait-times in a future round.)
- **UI:** rebuilt Route Optimizer screen off `#routerCard` — pick the job, show the two
  recommendations. Mobile-first, matches existing screen patterns.

---

## 7. Open questions (pre-build)

1. **Return leg** — does R1 cost/time include the truck returning to base (or heading to the next
   job) after the disposal stop, or stop the clock at the disposal site? *Lean: stop at the disposal
   site for R1 (the variable being compared is which site); add return/next-stop in a later round.*
2. **Job service time** — is it a constant we can ignore for *ranking* (same across sites), or do you
   want it shown in the absolute time estimate? *Lean: ignore for ranking, optionally display.*
3. **Multiple trucks** — if a franchise has several trucks live, does the user pick the truck first?
   *Lean: yes, pick the truck (we already list them on the Trucks screen).*
4. **Trigger point** — launched from the Route Optimizer home card with a job picker, or also
   reachable from inside an open estimate/job? *Lean: home card first.*

---

## 8. Build sequence (after approval)

1. This spec approved.
2. `cost_settings` disposal-site fields (minimumType/minimumValue) + Settings UI.
3. `crewlogic-route-disposal` edge function (Distance Matrix + math).
4. Rebuilt Route Optimizer screen (telematics-gated) + recommendation UI.
5. Smoke test on dev with #90 (real telematics + real disposal sites) → promote.
