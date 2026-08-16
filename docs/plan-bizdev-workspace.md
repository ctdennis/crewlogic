# CrewLogic Biz-Dev Conversion Workspace — Plan (FW-66)

**Status:** APPROVED 2026-08-14 — BUILDING. Phase order P0 (read-only workspace shell + forecast queue)
first; the Vonigo WRITE phases (P2 slot-lock, P3 convert, P4 appointment-create, + the Lost write-back)
each get a contract/schema check before code (contract-before-code). Build on `dev`; course-correct
from the running surface rather than over-planning. Author: session 2026-08-14.
**Related:** `plan-pipeline.md` (the pipeline sources), `plan-ny-estimate.md` (Estimate Costing),
`plan-sales-calendar.md` (FW-64 peripheral reminders), `plan-payments.md` (Stripe/deposits),
`plan-dispatch-dashboard.md` (availability + map + moveJob).
**Memory:** `vonigo-five-type-recognition`, `vonigo-route-model-and-estimate-classification`,
`vonigo-duplicate-customers-no-merge`, `pipeline-sources-from-job-mirror`.

---

## 1. The opportunity

A biz-dev manager's whole day is one loop: a pipeline event (lead / estimate / cancellation / UCB /
case) lands -> decide -> price it -> quote it -> chase it -> it books or dies. Today that loop is
split across CrewLogic (cost it) and Vonigo/Pipeline (find it, chase it), so the manager
context-switches constantly and loses the thread. The value is not "two screens in one" — it is
**collapsing that loop into one place so they never leave the flow**, and layering on the levers only
CrewLogic can offer (route density, live availability, margin headroom).

## 2. The model: one workspace = EV queue + work surface

A desktop-only cockpit built on the classic **list + detail** pattern (inbox / CRM deal board):

```
+-----------------+--------------------------------------------------+
|  WORKLIST       |   WORK SURFACE (changes by item type)            |
|  (EV-ranked)    |     • needs pricing -> Estimate Costing surface  |
|  [Leads]        |     • lead -> qualify + new-appointment          |
|  [Open est.]    |     • cancellation -> win-back new-appointment    |
|  [Cancellations]|     • UCB -> assign route + slot (+ real dur.)    |
|  [UCB] [Cases]  |   [ Quote ] [ Text ] [ Email ] [ Book slot ]     |
+-----------------+--------------------------------------------------+
|  TODAY: new 12 · worked 7 · quoted 5 · booked 3 · win 43%          |
+-------------------------------------------------------------------+
```

Click an item -> it opens in place on the right -> act -> next. Estimate Costing stops being a
separate destination and becomes the **detail view for a pipeline item that needs a price**. Mobile
is out of scope for this cockpit (it is a manager's desk tool).

Design rules: worklist is **collapsible category groups** (Leads / Open Estimates / Cancellations /
UCB / Cases) — NOT one long list (owner 2026-08-14) — each header showing **count + total $ (EV)**,
**EV-ranked WITHIN each group**; every row has a next action + one-tap way to do it; context rides with
the item (why it is here, last touch, prior quote, best-effort history); working an item empties the
queue and records the outcome; keep the work surface focused on one item.

Worklist shape:
```
▼ Open Estimates (6) · $14.2k EV     <- collapsible header: count + total EV
   McCarthy  $2.4k · 2d · Falmouth        [Cost] [Quote]
   Primini   $1.9k · online · Sandwich    [Cost] [Quote]  ...
▶ Leads (4) · $6.1k
▶ Cancellations (3) · $5.8k
▼ UCB (2) · $1.3k
   Northup   $650 · 6/24 callback          [Assign]
▶ Cases (0)
```
(Optional cross-category "Top opportunities" pin later; default view is collapsible-by-category.)

## 3. Priority = expected value

Rank the single merged queue by **EV = opportunity $ x P(close)** (owner principle). Both are derivable:

- **$ = "Opportunity"** (the metric's name) — shown WITH provenance + confidence, never fake-precise.
  If a real price is on the item (estimate quote; the rare pre-priced cancellation) → use it (high
  confidence). **Most cancellations have NO price, as do raw leads and callback UCBs** → **AI derives
  the opportunity from the item's description** (WO summary / cancel comments / lead note; photos when
  present) by **REUSING the volume-estimate engine** (`crewlogic-volume` / reverse-estimate:
  description/photos → truckload volume → zone price book → $), returning a **confidence** (High/Med/Low).
  AI figures render with a `~` + their confidence and firm up to a real price once the item becomes an
  estimate. Ranking multiplies Opportunity by P(close).
- **P(close)**: start as a heuristic table by (type x age x source); learn it later from the Analysis
  Engine. Starting priors: UCB high (they asked for a callback), fresh estimate high (decays with
  age), lead medium, cancellation low-rate/high-value, case very low.
- **Forecast = P(close) x Opportunity.** The **sum across the pipeline is the SALES FORECAST** (owner
  2026-08-14) — surfaced as a pipeline-forecast KPI up top + a per-category forecast total in each group
  header. Each item's forecast IS its EV rank key; the worklist sorts by it. (A Follow-up/deferred item
  may later carry an explicit P(close) override — see 4b.)

EV interleaves the types (a $600 UCB can outrank a $2,000 aged estimate) — which is exactly why one
merged queue beats five separate lists.

## 4. The five pipeline types -> three Vonigo write-paths

The "convert" action is a different Vonigo write per type. They collapse to THREE paths:

| Type | Lives in Vonigo as | Convert action | Write-path | Have / build |
|---|---|---|---|---|
| **Estimate** | a **Quote** | native "Convert Into Work Order" | **A: Quote-convert** — `POST /data/Quotes/ {method:2, quoteID, lockID}` (lockID = reserved slot) | build (needs slot-lock) |
| **Lead** | a Client (stage 123="Lead") | create net-new appointment | **B: Appointment-create** — full-field POST | build (linchpin) |
| **Cancellation** | a cancelled WO (status 162/163) | fresh sell (no triage API) -> create net-new, prefilled from dead WO | **B: Appointment-create** | build (linchpin) |
| **Case** | `/data/Cases` (rare) | create appointment | **B: Appointment-create** | build (reuses B) |
| **UCB** | WO on "Pending-Other (URGENTCB)" route 2987 | assign real route + day/slot | **C: Route-assign** — `moveJob` + set REAL duration | mostly have (`moveJob`) |

Note on UCB: the lane pins everything to a **1-hour placeholder duration** (Vonigo display
convenience). On assignment the **real duration** (from the zone — see below) MUST overwrite it or the
job books as 1 hr.

## 4b. Stage + outcome model (settable per item)

Each item carries a **Stage** (New / Contacted / Quoted / Scheduled / Won / Follow-up / Lost) the manager
sets. Actions on the work surface: **Schedule/book** (the write-paths above → Won), **Reschedule** (move
an existing booking), **Set follow-up** (defer with a date → stays in the pipeline; ties to the FW-64
sales calendar), **Mark lost** (with a reason). Stage + lost-reason lists are placeholders — fine for v1.

**Marking LOST writes back to Vonigo, TYPE-SPECIFICALLY** (owner 2026-08-14) — not one action:

| Type | Lost → Vonigo |
|---|---|
| Estimate | mark the estimate **Lost** (label 9993) or remove it |
| Lead | **deactivate** the lead (Client, stage 123) |
| Cancellation | **update the cancel-reason code** only (Job 974/975 — no longer "Scheduling"); it just falls off CrewLogic |
| Case | mark **100%** resolved (defer — few cases) |
| UCB | **cancel** the WorkOrder (status 162) |

Write-back stance: booking + Lost keep Vonigo truthful; Follow-ups live in CrewLogic's calendar.
**Future (punt):** a Follow-up/deferred item may carry a **probability-to-close** field feeding the EV
rank (Opportunity × P(close)). Detail: memory `bizdev-lost-outcome-vonigo-writeback`.

## 5. The slot-lock spine (net-new — first real build)

**Confirmed by code (`crewlogic-estimate` submitQuote, ~700-790): submitQuote creates a Quote +
photos + field edits + sets the estimate label. It does NOT reserve a slot, get a lockID, or convert.**
So the **reserve-slot -> `lockID` primitive is net-new** and is the **shared spine** for Path A
(estimate convert) and Path B (appointment create). Build it once against `/resources/availability`;
both paths ride it. This is the first real build, not a freebie.

Sub-capability needed: given a location + service type + duration + a chosen slot, obtain a `lockID`
(the reserved-slot token), then either (A) `/data/Quotes/ method:2` with `quoteID + lockID`, or (B)
create the appointment WO with the locked slot. `submitQuote` proves the MD5 create/edit plumbing.

## 6. Route-density recommendation (the CrewLogic-unique lever)

The Vonigo booking chain (owner screenshots 2026-08-14):

```
Address -> ZIP -> ZONE -> Price List + DURATION (per service type; e.g. Local JR 1.5h)
                    -> Availability Template (zone placed on days/hours) -> Route Assignment -> Route(s)
```

- **`/resources/availability` already answers "which routes are open for this zip on this day"** — it
  respects zip -> zone -> AT -> route -> capacity by construction. We do NOT reverse-engineer
  zip->route; we ask availability (location + serviceType + duration).
- **Duration comes from the ZONE** (not a guess). This resolves two things at once: the availability
  call needs it as input, and it is the REAL job duration for appointment-create + the UCB fix.
- **Route density = a re-rank OVER the eligible openings**: prefer the day/route where our geocoded
  job mirror shows nearby jobs (denser route = less drive = higher margin). Two flavors: reactive
  (per item: "3 jobs already near this address Thu on MA3ALL") and proactive (fill view: open-capacity
  days that have a nearby anchor job). Vonigo decides eligibility; we optimize which eligible slot to push.

## 6a. The "Schedule with density" panel (the UI the manager acts in)

When the manager schedules or reschedules an item to a date, ONE panel makes the density lever
tangible — map on the left, a date picker on the right, nearby jobs shown against each candidate date:

```
SCHEDULE: McCarthy — 12 Elm St, Falmouth 02540   (Zone: MA-Regular · JR 1.5h · route MA3ALL)
+------------------------------+------------------------------------------------+
|   MAP (10-mi radius)         |  PICK A DATE  (only dates MA3ALL serves 02540)  |
|                              |                                                |
|         * McCarthy (here)    |  Thu 8/21   ●●● 3 near   9:00  12:30 open   ★  |
|      oLynch   oMotta         |     Lynch 8a · Motta 10a · Pratt 2p  (MA3ALL)  |
|          oPratt              |  Fri 8/22   ●  1 near    8:00 open              |
|    oPrimini                  |     Primini 11a                                |
|                              |  Sat 8/23   —  none      9:00 open              |
|  o = existing job (by date)  |  Mon 8/25   ●● 2 near    no openings  x         |
+------------------------------+------------------------------------------------+
  ★ recommended: Thu 8/21 — 3 jobs already on MA3ALL near here + open slot (denser route)
  [ Reserve Thu 12:30 ]   -> holds the slot (lockID) -> convert (estimate) / create (lead/cxl)
```

**How it's assembled (the mechanics):**
1. **Geocode** the item's address → point + **ZONE** (zip→zone) → service **DURATION** + the serving **Route(s)**.
2. **Ask `/resources/availability`** (location + serviceType + duration) → **OPEN SLOTS per date/route** —
   the eligible, bookable openings ("which dates/routes can even take this job"). Non-serving routes and
   full days never appear.
3. **Query the geocoded job mirror** for existing jobs within ~10 mi over the candidate window, grouped
   by date, **filtered to the serving route** (same-truck clustering) → "**nearby jobs and WHEN they land**."
4. **Overlay** per candidate date: its open slots (from 2) + its nearby-job count/list (from 3); **flag
   the date that maximizes nearby jobs AMONG bookable dates** (the efficient day). Map pins are colored by
   date; clicking a date highlights that day's cluster.
5. Manager picks a **date + slot** → **reserve (lockID)** → the convert (estimate) or create
   (lead/cancellation) path books it.

**Precision:** "nearby" ideally means nearby jobs **on the Route that would serve this address** (same
territory/truck) — that's what actually densifies the route and saves drive; the mirror's route relation
lets us count precisely (raw proximity is only a proxy). **Reschedule** = the same panel with the item's
current date marked; "move" = pick a denser bookable date. Everything feeding this panel already exists
except the density overlay (mirror radius query + the date/slot re-rank) and the shared slot-lock.

**Launch point (owner 2026-08-16):** this density panel is what **"Find times"** opens in the future phase.
Today Find times returns a flat, zoned, in-hours slot list (the groundwork). Later it opens the map + date/
route/nearby-jobs view so the manager combines **dates × routes × future jobs** into an informed placement
decision — same button, richer surface. (Prereqs already shipped in the booking modal: zip → zone → duration,
territory guard, availability-template hours.)

**Drive time + miles per candidate (owner 2026-08-16):** for each candidate date/slot, show the **drive time
and miles** to reach this job — from the **nearby anchor job on the serving route** (same town / adjacent
time), not just from the office. This frames the ROI: "book next to the Falmouth 12:30 → +6 min / +3 mi vs a
standalone day at +40 min / +22 mi." It quantifies the time/fuel savings of co-locating and makes the ★
recommended day concrete. **Mechanics already exist:** Google Distance Matrix is wired (`crewlogic-estimate`
`calcDistances` for cost-analysis routing + the dispatch map's point-to-point) — reuse it: anchor job coord →
this address, per candidate date. Show it inline on each date row and on the map leg.

## 7. Customer history (best-effort, async)

Vonigo allows **duplicate customers** — every online booking mints a NEW Client, no auto-merge. So:
history is **best-effort, precomputed/async (not live fuzzy-search — latency), exact-identifier-first**
(normalized phone digits, exact-lowercase email; name = low confidence). Surface as a hint ("possible
repeat — 2 prior jobs, paid"), never authoritative, never auto-merge. Even best-effort it pays off:
"repeat, always pays" lets the manager book at standard and skip the discount.

## 8. Value-add levers (layer onto the work surface)

- **Margin headroom** (in the costing surface): "how low can I go and still clear the floor?" +
  "margin if I slot this into an existing route" (density lowers drive cost). Objection handling with
  a guardrail (ties to the pricing-integrity rule).
- **Deposit-to-hold** (when Stripe lands, `plan-payments.md`): commitment device, lifts close/show rates.
- **Conversion analytics** (Analysis Engine, FW-62): win rate by source / price band / response time;
  feeds both coaching and the P(close) priors.
- **Speed-to-lead**: the EV queue + online/same-day signals surface hot items first.

## 9. Phased sequence (proposed)

- [x] **P0 — Workspace shell + EV queue (read-only).** SHIPPED TO DEV v5.124.22 (2026-08-14). One
      merged, forecast-ranked worklist (reuses the read-only `crewlogic-pipeline` `list` action) + a
      right-pane work surface; click item -> read-only detail (estimate quote / non-estimate context).
      No writes — every action button is a stubbed toast. Proves the loop. See build-log §12.
- [ ] **P1 — Path C (UCB assign).** Lowest-risk write; reuses `moveJob` + availability. Adds the
      zone->duration lookup (overwrite the 1-hr placeholder). First real conversion end-to-end.
- [ ] **P2 — Slot-lock spine.** Reserve-slot -> lockID against `/resources/availability`. Shared by A+B.
- [ ] **P3 — Path A (estimate convert).** `/data/Quotes/ method:2` + lockID. Estimate -> booked WO.
- [ ] **P4 — Path B (appointment-create).** Full-field POST; unlocks lead + cancellation + case
      (prefill wrappers over one creator). Pricing-integrity-level rigor on required-field validation.
- [ ] **P5 — Levers.** Route-density re-rank, best-effort customer-history hint, margin headroom.
- [ ] **P6 — Deposit + analytics.** After Stripe / Analysis Engine mature.

## 10. Open questions / confirms before build

1. **Slot-lock mechanics**: what Vonigo call reserves a slot and returns the `lockID`? (Not in our
   code today — must be found in the Vonigo API before P2.)
2. **Appointment-create required fields**: the exact mandatory field set for a net-new WO (client,
   contact, location, serviceType, route, date/time, duration, zone, charges?). Extend submitQuote's
   payload assembly as the template.
3. **P(close) seed**: acceptable starting priors per type before the Analysis Engine can learn them?
4. **Cancellation prefill**: how much of the dead WO + job mirror do we prefill vs. re-collect?
5. **EV $ for leads with no number**: franchise-average, zone-average, or a manual quick-estimate?

## 11. Reuse inventory (what already exists — keeps this cheap)

- Pipeline sources (cancel/estimate/UCB/lead/case) — `plan-pipeline.md` + the job mirror.
- `moveJob` + availability + the map + geocoded jobs — `crewlogic-dispatch`, dispatch dashboard.
- Estimate Costing (rooms/margin, volume from charges/AI) — `plan-ny-estimate.md`.
- Vonigo MD5 create/edit plumbing — `submitQuote` in `crewlogic-estimate`.
- Price book / truckload $ + zone durations — Vonigo Zones/Price Lists (read via availability).
- Follow-up reminders / sales calendar — `plan-sales-calendar.md` (FW-64).

## 12. Build log

- **P0 — read-only Sales Workspace (v5.124.22, dev, 2026-08-14).** Additive-only; new `bw*` namespace
  (functions/ids/state/CSS), zero changes to the Follow-up Pipeline (`_pl*`) or any existing function.
  - New screen `#bizdevScreen` (near `#pipelineScreen`), registered in `allScreens`, `openModule('bizdev')`
    case (calls `_ecWide()` for full desktop width, then `renderBizDev()`).
  - Launcher card `#bizdevCard` ("Sales Workspace"), gated in `applyOwnerCards` to `IS_DEV_ENV ||
    super-admin (charles.dennis@junkluggers.com)` — desktop beta.
  - Data: read-only `edgeFunctionCall('crewlogic-pipeline',{action:'list'})` into own `_bwItems`.
  - Forecast heuristic (client-side, new): `P(close)` = type base `{unconverted_estimate:.55, ucb:.5,
    lead:.3, cancellation:.25, case:.1}` × age-decay `max(.4, 1 - daysOld*.03)`; `forecast = round(P × amount)`
    only when `amount` present. Forecast KPI = Σ forecast over amount-bearing items. Groups sort by forecast
    desc (no-amount items last, shown as "— AI estimate pending"). AI-derived opportunity for no-amount
    items (leads/cases) is deferred to a later phase per spec.
  - Detail pane: header (badge, name, address, DISPLAY-ONLY stage pill, clickable tel:/mailto: chips,
    forecast), estimate quote card with source-aware "Open in CrewLogic/Vonigo" (stub toast), non-estimate
    context card, and a stubbed action bar (Schedule/Reschedule/Set follow-up/Mark lost → toasts).
- **Follow-up actions:** P1 (UCB assign) is the next live task; the §9 checkboxes remain the tracker.

---

*P0 shipped read-only; P1–P6 remain gated on the §10 confirms (slot-lock mechanics, required-field sets)
and owner go per phase. The §9 phased checkboxes are the live tracker.*
