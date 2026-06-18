# Route Optimizer — Round 1 Spec (Disposal-Stop Recommender)

**Status:** Draft for owner approval · **Created:** 2026-06-18
**Owner:** charles.dennis@junkluggers.com
**Related:** Hub "Route Optimizer re-architecture" row · memory `route-optimizer-rearchitecture` · `docs/plan-payments.md`

The full Route Optimizer is single-tenant (#90-only, n8n + owner's Google Sheet). Round 1 is a
**slimmed, multi-tenant disposal-stop recommender** built on the existing per-franchise
`cost_settings` + cost engine — no n8n, no Google Sheet, no geofences.

---

## 1. What Round 1 does

The route being optimized is **truck's current location → transfer station → job**. The truck is
loaded and must dispose *before* reaching the next job; the **job is the fixed endpoint**. For each
candidate disposal site, compute total time (leave current location → arrive at job) and total cost
(disposal fee + crew labor over that time + fuel), then surface the **least-cost** and **least-time**
options as a recommendation.

**Why the job must be the endpoint (owner, 2026-06-18):** if we only measured "closest station with
least wait," the optimizer would pick a cheap/near station even when the station→job drive balloons.
Anchoring on the job endpoint optimizes the *whole* path, not just the disposal stop.

**Out of scope for R1:** recycling/donation sites, multi-job day routing/sequencing, geofence-derived
wait-times (use the manual per-site wait time already in settings), truck-load/volume packing,
return-to-base leg (clock ends at job arrival).

---

## 2. Gating

- **Available ONLY if the franchise has Motive OR Linxup connected** (the recommendation starts from
  the truck's live position). Gate on the existing per-franchise telematics status (`getTelematics`).
- In the payments matrix: **Pro+ tier AND telematics connected.**
- The existing `#routerCard` (currently hard-gated to #90) is re-gated to telematics-connected; the
  old n8n route call (`crewlogic-route`) is NOT used by R1.

---

## 3. Inputs (all already available)

All of these already exist on the current `#routerScreen` (reuse the helpers, not the n8n call):

| Input | Source |
|---|---|
| Truck current position | live telematics (`getTruckLocations` → `crewlogic-trucks`, :8395) |
| Truck auto-assignment | **device location → nearest truck via haversine** (`getUserLocation` :8384 + :8318-8329); picker fallback if GPS fails — feature already exists |
| Job (endpoint) | today's Vonigo jobs picker (`loadUpcomingJobs` → `crewlogic-todays-workorders`, :8350), storage option, or manual job ID |
| What's in the truck | **load % full** entry (`routeLoadPct`, default 75%, :8312) → `CY = load% × truckCY` → `tons = CY / 16` |
| Candidate disposal sites | `cost_settings.disposalSites[]` (address + per-site rate + new minimum fields) |
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

**Hours of operation (pending decision #2 in §7):** the n8n's transfer-station sheet carried per-site
`Weekdays` ("open-close"), `Saturday`, `Closed` (days), `Holidays`, plus `Status` (Open). If we adopt
open-at-arrival filtering, add per-site **hours** (weekday open/close, Saturday open/close, closed days)
to `disposalSites[]`. Full holiday calendar can be a later round.

**n8n transfer-station schema (reference, from the Sheet → our `disposalSites[]` mapping):** `TS Name`
→ name; `Address`/`Latitude`/`Longitude` → address (we geocode); `PerTonRate` → rate ($/ton; **negative
= recycling revenue**, out of R1 trash scope); `Minimum?`+`MinRate` → our minimum (dollar case);
`DefaultWait` → `disposalWait`; `Weekdays`/`Saturday`/`Closed`/`Holidays`/`Status` → hours; `MotiveID`
→ truck/station match. Weight-based minimums are NEW (n8n had dollar-only).

---

## 5. Cost & time math (per candidate site)

Let `W` = tons in truck (`CY/16`), `R` = site rate ($/ton).

**Disposal fee:**
- `none` → `W × R`
- `weight` (min `M` tons) → `max(W, M) × R`
- `dollar` (min `$D`) → `max(W × R, D)`

(Above any minimum, always prorated by actual weight — no whole-ton round-up.)

**Time (clock starts leaving current location, ends arriving at job):**
`drive(current → site) + disposalWait + drive(site → job)`. Both drive legs via Distance Matrix.
Job service time is OUTSIDE this window (route ends at job arrival) → not used for ranking; if Vonigo
exposes it, optionally display it as supplemental.

**Total cost** = disposal fee + **crew labor over the whole route** (`2 × crewRate × totalTime`,
where totalTime = drive + wait) + **fuel** (`routeMiles / MPG × fuelCost`, where routeMiles =
truck→station + station→job).
- `crewRate` is **per-person** (`cost_settings.crewRate`, default $25). **R1 assumes a fixed
  2-person crew in the truck at all times** → labor multiplies by 2. (The n8n hardcoded a single
  blended $55/hr; we use 2 × per-franchise `crewRate`.) The Settings field label is clarified to
  **"Crew $/hr (per person, fully loaded)"** so franchisees don't enter a combined-crew value
  (index.html:1634).
- **Wait time is billed at the full crew rate** (idle wait = same $/person/hr as driving). Confirmed.

> **Reconciled with — and deliberately diverging from — the n8n trash-only model
> (`Calculate Arrival Times and Warnings`):** the n8n computes
> `totalRouteCost = disposalCost + laborCost` with **no fuel** and a **hardcoded $55/hr** labor rate.
> We **add fuel back** (mileage is route-dependent — different stations = different total miles — and
> `MPG`/`fuelCost` already exist per-franchise and are used in the estimate cost analysis) and use the
> **per-franchise `crewRate`** instead of $55. Disposal math kept: `disposalCost = max(0, perTonRate)
> × tons`, floored by the minimum if set. The n8n minimum is a **dollar floor only** (`Minimum?`=Y/N +
> `MinRate`=$); we KEEP the broader none/weight/$ selector — the owner confirmed other franchisees have
> **weight** minimums (1/2/3-ton), which the n8n doesn't model. The n8n uses `tons = percentFull/100`
> (its truck = 16 CY); our `tons = CY/16` generalizes to any `truckCY`.

**Recommendation:** rank candidate sites and return the **least-cost** and **least-time** picks
(may be the same), each with its cost + time breakdown. *(See §7 — whether R1 also adopts the n8n's
schedule-window awareness is an open decision.)*

---

## 6. Architecture (off n8n)

- **New edge function** (e.g. `crewlogic-route-disposal`): takes franchiseID + truck current
  position + job address + load CY; reads `cost_settings` (service role), calls Distance Matrix for
  the two legs per site, applies the math above, returns ranked sites + the two recommendations.
  Reuses the existing cost-engine logic (index.html ~19179–19404) ported server-side. **Authoritative
  logic to match: the n8n "trash-only" route model (owner to upload) — reconcile this spec against it
  before building.**
- **No new tables for R1** — disposal sites + costs live in `cost_settings` (JSONB), distances are
  computed live, truck position is live telematics. (Tables come later for accumulated geofence
  wait-times in a future round.)
- **NEW card + screen — do NOT touch the existing `#routerCard` / `#routerScreen`** (the #90-only n8n
  optimizer stays live, undecommissioned). The new screen REUSES the generic input helpers from the
  existing screen (`getUserLocation`, `getTruckLocations`, haversine nearest-truck, `loadUpcomingJobs`,
  load%), and replaces ONLY the n8n route call with `crewlogic-route-disposal`. New card gated on
  telematics-connected (+ Pro tier). Mobile-first, matches existing screen patterns.

---

## 7. Decisions (resolved 2026-06-18)

1. **Endpoint / legs** — RESOLVED: route = current location → station → **job (endpoint)**; clock
   leave-current → arrive-job; no return-to-base leg in R1.
2. **Job service time** — RESOLVED: outside the optimized window → not used for ranking; pull from
   Vonigo for display only IF available, else ignore.
3. **Truck assignment** — RESOLVED: reuse the existing device-location → nearest-truck auto-assign
   (haversine), with the truck picker as fallback.
4. **Trigger / card** — RESOLVED: a **NEW separate card + screen**; the existing #90 n8n card stays
   live (not decommissioned).

### Reconciled with n8n (`docs/Route Optimization.json`) — 2026-06-18
- Leg model CONFIRMED (current → station → job, no return leg). Time = drive+drive+wait.
- **Cost: we DIVERGE from n8n** — n8n = disposal + labor only (no fuel, hardcoded $55/hr). We add
  **fuel** (route-dependent) + use **per-franchise `crewRate`**. Minimum dollar-only in n8n; we keep
  none/weight/$ superset.
- Wait time: n8n pulls **historical per-station/day/hour averages** from a Google Sheet — that's the
  accumulate-over-time geofence piece we DEFER. R1 uses the static per-site `disposalWait`.
- Materials (mattress/TV/tire/cardboard/clothing → storage; metal/donations → recyclers) drive the
  n8n's *scenario* engine. **R1 = disposal only → treat the whole load as trash**; the scenario engine
  (metal/donations/storage/partial-load A-B-C) is a later round.

### Resolved 2026-06-18 (owner)
- **Wait time:** R1 = single static per-site wait from cost settings. **Future:** use the facility
  location data already in cost settings to create **geofences in Linxup/Motive** that track vehicle
  enter/exit at each disposal/recycling/donation site and accumulate real wait times; add a
  **facility category** (disposal / recycling / donation) to align facilities with their geofence/type.
- **Recommendation:** show **BOTH** the cheapest and the least-time option (don't auto-pick one) —
  some days you pay more to fit more jobs, other days you take the cheapest. **Future:** an **AI
  recommendation** that, knowing the truck's route (how many jobs and at what times), suggests whether
  to optimize for cost or time on that particular day.
- **Labor:** 2-person crew assumed always; wait billed at full crew rate (see §5).
- **Density:** 16 CY = 1 ton (locked).

### Still open
- **Hours of operation?** The n8n filters out **closed** stations (per-site weekday/Saturday hours,
  closed-days, holidays) and flags "cutting it close" (<15 min before close). You've called out hours
  as franchisee-entered data. Include open-at-arrival filtering in R1 (so we never recommend a closed
  dump), or defer to a later round? *Lean: include basic open/closed; full holiday calendar later.*

### Security finding (action needed)
- `docs/Route Optimization.json` contains **live API keys** (Google Maps, Anthropic ×2, Motive token)
  in the `Workflow Configuration` node. Recommend: **rotate** those keys and **strip/remove** the file
  (logic now extracted into this spec). Ties into the Google-credential-cleanup project. Tracked in Hub.

---

## 8. Build sequence (after approval)

1. This spec approved + reconciled against the n8n trash-only model.
2. `cost_settings` disposal-site fields (minimumType/minimumValue) + Settings UI.
3. `crewlogic-route-disposal` edge function (Distance Matrix + math).
4. NEW Route Optimizer card + screen (telematics-gated; reuses existing input helpers; existing #90
   n8n card untouched) + recommendation UI.
5. Smoke test on dev with #90 (real telematics + real disposal sites) → promote.
