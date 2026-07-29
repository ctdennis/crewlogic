# AI Volume View — Daily Schedule Fill Forecast (Spec)

**Status:** Draft for review — brainstorm output, NOT yet approved for build.
**Tracker:** FW-60 (see `.HUB/Hub.md`).
**Extends:** FW-59 (truck→route assignment + schedule feasibility / finish-speed dial). This adds a
**volume** layer on top of the existing **time** feasibility.
**Origin:** Owner brainstorm 2026-07-29 ("Pac-Man, one joystick — not Xbox").

---

## 1. Problem & goal

Today the dispatch board answers **"will the trucks make their time windows?"** (feasibility colors +
finish-speed dial). It does **not** answer **"will the trucks fill up, and when do we stop to dump or
grab an empty can?"**

**Goal:** an optional, AI-assisted **volume forecast** layered on the daily schedule that predicts each
truck's cumulative fill across the day and marks the point it needs to unload — with a dead-simple
on/off and a single adjustment control.

## 2. Design principle — Pac-Man, not Xbox

One joystick, not a controller full of buttons. The common path is:

- **ONE button** — the **AI button** in a route's detail panel overlays the volume estimate on that route.
- **Defaults do the work** — each segment starts at its AI value; you only touch a per-segment slider on
  an exception (crew consolidated, runs heavier), and only pick a disposal branch when a truck fills.
- **ONE occasional Refresh** — appears only when a job's description is new or edited.

Everything else responds automatically. The depth (per-segment sliders, disposal-row choices) is
*progressive* — present when you need it, invisible when you don't (see the Pac-Man check in §15).

## 3. Two layers

- **Layer 0 (shipped):** *time* feasibility — will trucks make their windows. Finish-speed dial.
- **Layer 1 (this spec):** *volume* fill — will trucks fill, and when. Adds one visual: a per-route
  fill bar + a single "unload here" pin.

Layer 1 is purely **additive**. Off → the board is exactly what it is today.

## 4. The keystone: AI once (cached), everything interactive is free

The single most important architectural decision — separate the expensive part from the interactive part:

- **AI runs once per job:** reads the Vonigo `summary` + `items` fields, returns
  `{low, high, confidence}` cubic yards.
- **Cached** by `woID` + `hash(summary + items)`.
- **The slider, cumulative fill, pin placement, and crew actuals are all pure client-side math** — they
  never re-call AI.

Result: instant, zero-cost interactivity; AI spend is bounded, predictable, and opt-in (ties directly to
the AI-calls metering already shipped in FW-59).

## 5. Interaction model — per route, in the details rail

**Clicking a route cell opens that route's feasibility in the left details rail** (replacing the modal),
consistent with every other clickable thing on the dispatch. It shows the route **as it stands now** —
the current *time*-feasibility breakdown, no AI, no cost.

At the **top of that panel is the AI button.** Press it and the AI estimate is laid onto **each segment
(job)** of the route:

- Each segment shows its AI volume plus a **per-segment slider** to set the load **more or less** than
  the AI number. Default = the AI estimate; you only touch it to override (crew consolidated, or you know
  it runs heavier).
- The per-segment slider is the **single adjustment mechanism** — it *replaces* both the earlier global
  "lean" slider and the separate "set actual" tap. One control type, per job, defaulting to AI.

**Scope:** the AI view is a **per-route drill-down** — you plan one truck's day at a time in the rail, not
a board-wide mode. The **AI button is the "one press";** segment sliders are progressive depth you touch
only when reality differs from the estimate. (This is richer than the single-global-slider sketch — see
the Pac-Man note in §15.)

## 6. The fill line, the inserted disposal row, and its time cost

As the per-segment volumes accumulate down the route, when the running total crosses the truck's capacity
the panel **inserts a "🛢️ Truck full — disposal" row** at that point in the segment list (the
list-native form of the "unload pin"). If a route fills more than once in a day, a row inserts at each
crossing.

In that row the user checks one of two branches:

- **Return to truck parking** (swap to an empty can), or
- **Go to a disposal facility.**

Choosing **disposal facility** makes the row **cost time**, which pushes every downstream stop later and
re-colors the route's feasibility (this is where the *volume* layer feeds back into the *time* layer):

- **Drive time to the facility** — computed live (Google Distance Matrix), reusing the existing
  disposal-finder + facility geocoding.
- **Average on-site wait** — from **geofence history** (arrive→leave dwell at that facility), see §6a.

The **return-to-parking** branch also consumes time (drive to the yard + a can-swap) — its timing basis is
an open item (§15).

### 6a. Dwell from geofence history — daytime window, gated at 3 months

Both stop types get their **wait / swap** time from geofence arrive→leave dwells:

- **Disposal facility** → average dwell at that facility.
- **Return to parking** → average **mid-day** dwell at the yard / truck-parking geofence (the drop-and-swap).

**Critical filter — exclude the overnight park.** The truck sits in the yard overnight, so raw yard
dwells are dominated by a ~14-hour overnight sit that wrecks the average. The average therefore uses
**only dwells that fall inside the operating window** (default **7 AM – 6 PM, franchise-local**): a real
mid-day swap (arrive 1:00, leave 1:20) counts; the overnight pair (arrive ~6 PM, leave next morning) is
dropped because it crosses the window boundary. Likewise the morning "leave for the day" and evening
"return to park" are not swaps and fall out naturally. (Applying the same daytime filter to facility
dwells is harmless and guards against stray events.)

**Dwell hygiene — clean the sample before averaging:**

- **In-window only** (7 AM–6 PM) — excludes the overnight park (above). The **operating window is derived
  from the franchise's route hours** (TZ-resolved; 7 AM–6 PM only as a fallback default) — *resolved,* not
  hardcoded.
- **Pair arrive→leave per VEHICLE, and keep only clean same-truck round-trips.** A crew that comes in on
  **truck 1 and leaves on truck 3** must NOT be mis-paired (truck-1 "in" with truck-3 "out"): truck 1 then
  sits parked and truck 3 had been parked since overnight, so neither is a real swap. Averaging only
  **unambiguous same-truck in/out pairs** edits those cross-truck swaps out (owner 2026-07-29).
- **Cap absurd dwells** — a missed exit ("arrived, never left") reads as a giant dwell; discard anything
  beyond a sane max so one bad event can't skew the average.
- **Minimum sample size** — require enough qualifying visits (not just 3 months elapsed) before trusting
  the computed average.

Then:

- **> 3 months AND enough clean visits** → use the computed average.
- **Otherwise** → fall back to the **Cost-settings default** — a "can-swap / disposal dwell" default
  (minutes), in the same Cost settings area as truck capacity + facilities.
- **Drive time is always computed live;** only the dwell needs the history-or-default path.

### 6b. Live geofence closes the loop (IN SCOPE — owner promoted from "later")

Because a disposal stop is a real geofence event, once a truck actually **arrives at a facility** its
geofence `arrive` **auto-confirms the planned disposal row** and feeds the **live ETA** (FW-59): the
planned stop becomes an actual, the real drive + dwell replace the estimate, and downstream stops re-time
from ground truth. Planning view and live view reinforce each other — the morning plan is a forecast; the
live geofence makes it fact. Layers on the existing live-ETA engine.

## 7. AI cost governance — you only pay for new eyes

AI spends a call **only** on (a) first turn-on for a route, and (b) pressing **Refresh** for jobs it
hasn't read. Nothing else charges. **Billing unit: per job the AI actually reads** — the
`woID + descHash` cache guarantees you never pay twice for the same job + description.

### Change taxonomy (what happens when the route changes)

| Change to the route | Today's fill | Costs AI? |
|---|---|---|
| Job **cancelled** | drops out | No |
| Job **moved off to another day** | drops out (same as cancel) | No |
| Job **moved / reordered within today** | re-sums | No |
| Job **moved onto today** (from another day) | slots in | **No** if estimated before (usual case); yes only if never seen |
| **Brand-new** job added | slots in | Only that one job |
| **Description / item list edited** | re-reads that job | Only that one job |

**Key insight:** the estimate is attached to the **job (`woID`), not the day** — so jobs sliding between
days carry their volume with them, free. On the dual-day board, dragging a job from tomorrow to today
moves **both** pins live (tomorrow lighter, today heavier) with **no** AI call on either side.

**The one durable rule:** *you only pay when the AI reads a description it hasn't seen before.*

## 8. Detecting a mid-life description / item-list change (customer calls, adds stuff)

Rare, but caught automatically on the **same rails as an add** — no new mechanism:

1. Staff update the job in Vonigo (edit `summary` / `items`).
2. Next board load re-hashes that job's current text and compares to the hash stored with its cached
   estimate.
3. Mismatch → that one job flags **"✎ updated"** and lights the same **"↻ Refresh"** nudge. Refresh
   re-reads only that job (1 call).

Two properties that keep it simple:

- **Hash the content, not a Vonigo "last-modified" timestamp** — a timestamp flips on any edit (crew,
  time, route) and would nag when the volume didn't change. Hashing `summary + items` flags **only**
  when volume-relevant text changed.
- **Degrades gracefully** — ignore the flag and the pin keeps the prior estimate (only slightly stale);
  and if the job's already done with a crew actual set, the edit is moot (the actual wins).

## 9. Crew actuals — the per-segment slider IS the override (free)

The AI gives a *forecast*; the crew gives *facts* — and both use the **same per-segment slider** (§5),
which defaults to the AI value:

- Untouched → the segment uses its AI estimate.
- Dragged → the segment uses the crew's real load (predicted ½, consolidated to ¼ → slide to ¼). Free,
  client-side; recomputes the fill line + any inserted disposal row instantly (no AI).
- Segments read **AI (default)** vs **adjusted (user-set)** so it's clear which are forecast vs confirmed.
  Through the day, more segments get set to actuals and the disposal point sharpens — zero extra AI.

## 10. Estimate-Only (EO) jobs — default out, convert on a tap

- EO jobs **default to 0 / not counted** (matches "we train teams to convert on the spot — start with no").
- If the crew converts on-site: **tap → "converted"** → it counts. Since the crew is standing in the
  unit, they'll usually hand you the **actual** — so a conversion typically needs **no AI**, just the
  same set-actual tap. (AI's value is the morning forecast; live conversions are better served by real
  numbers than a prediction.)

## 11. Truck capacity & disposal-wait defaults (settings)

- **Truck capacity — default 16 cu yd,** editable in **Settings → Cost Analysis.** Single global number
  for v1 (per-truck sizes later).
- **Default can-swap / disposal dwell — a new setting in Cost settings** (same area as capacity +
  facilities), used for the disposal-row time when the franchise has < 3 months of clean in-window
  geofence history (§6a).
- **Operating window** for the dwell filter is **derived from the franchise's route hours** (7 AM–6 PM
  fallback), TZ-resolved (§6a) — no separate setting needed.

## 12. Data model (sketch)

Per-job volume record, keyed by `(service_date, woID)`:

- `estimate`: `{ low, high, confidence, model, descHash, estimatedAt }`
- `actual`: `{ cuYd | hauled:bool, setBy, setAt }` (nullable)
- `eoConverted`: bool (nullable)

Route/day state:

- `sliderLean` — forecast position (persist per day so it sticks)
- `truckCapacity` — global cost setting (16 default)

**Lean toward a small relational table** (not a JSON blob on the day's state): it carries structured,
entity + time-series data (predicted vs actual per job over time), which supports the §13 self-calibration
and accuracy reporting. Consistent with the "ask before JSON-blob features" preference.

## 13. Future goldmine (design the data for it; don't build yet)

Storing **predicted vs actual** per job means that over a few weeks you learn your crews' real
consolidation ratio (e.g., "they pack down ~30%"). That can **auto-set the slider's default lean** so the
morning forecast starts pre-calibrated to *your* teams — the feature quietly teaches itself. Design the
data to allow it; ship without it.

## 14. Suggested v1 scope

**IN (v1):**
- Route-click → feasibility opens in the **details rail** (replaces the modal), current-state (no AI)
- **AI button** → per-segment AI estimate (`summary + items` → `{low, high}`), cached by `woID + descHash`
- **Per-segment slider** (default = AI, adjust more/less) — the one adjustment + actual mechanism
- Inserted **"truck full — disposal" row** at each capacity crossing, with **parking vs facility** choice
- Facility branch: **live drive time + geofence-history avg dwell (>3 mo, clean sample) or Cost-settings
  default (<3 mo)**, pushing downstream feasibility; return-to-parking derives its swap time the same way
- **Dwell hygiene:** in-window (route hours), per-vehicle same-truck pairing (edit out truck-1-in /
  truck-3-out swaps), missed-exit cap, minimum sample size (§6a)
- **Live geofence auto-confirms** a disposal stop and feeds the live ETA (§6b) — planning ↔ live loop
- EO default-out + "convert" (segment slider off 0)
- Description-hash staleness + Refresh (pay only for new/changed jobs)
- **Truck capacity** (16 cu yd) + **default can-swap/disposal dwell** — both in Cost settings

**LATER:**
- Per-truck capacity
- Auto-suggest *which* facility (nearest/cheapest via the disposal-finder) instead of user-picks
- Auto-calibrated default lean / wait from stored actuals (§13)
- Predicted-vs-actual accuracy reporting
- Board-wide "all routes at once" fill glance (v1 is a per-route drill-down)

## 15. Decisions

**Resolved (owner, 2026-07-29):**
- **Placement** → per-route in the **details rail**; the **AI button + per-segment sliders** live there
  (not a board-wide legend slider). Clicking a route shows current-state feasibility; the AI button
  overlays per-segment estimates.
- **Adjustment + crew actual** → **one per-segment slider** that defaults to the AI value.
- **Cache storage** → **relational table** (standing "ask before JSON-blob / default relational" rule).
- **Return-to-parking timing** → drive to the yard (live) + average **in-window** yard dwell (geofence
  history; §6a), > 3 mo + clean sample else Cost-settings default. Symmetric with the facility branch.
- **Overnight distortion + truck-swaps** → dwell averages use **only in-window (route-hours) dwells** and
  **only clean same-truck in/out pairs**, so the overnight park and truck-1-in/truck-3-out swaps never
  pollute the average (owner, 2026-07-29).
- **Operating window** → **derived from the franchise's route hours** (7 AM–6 PM fallback), TZ-resolved —
  no separate setting.
- **Default location** → the < 3-mo fallback ("can-swap / disposal dwell" default) lives in **Cost
  settings**, alongside truck capacity + facilities (not Truck Setup).
- **Live geofence auto-confirm** → **IN SCOPE** for v1: a truck's real facility arrival confirms the
  planned disposal row and feeds the live ETA (§6b).

**Still open:**
1. **Facility selection** — does the user pick the facility, or does it auto-default to nearest/cheapest
   (the existing disposal-finder) with an override?
2. **History-gate specifics** — is the 3-month window **per facility** (vs franchise-wide)? If a facility
   has < 3 mo but others have more, per-facility default fallback?
3. **Billing unit** — per-job-read *(recommended)* vs flat per-refresh.
4. **Pac-Man check** — per-segment sliders + disposal-row choices are richer than "one slider + one pin."
   The common path stays low-touch (press AI, defaults fill in, only touch a slider on an exception), but
   confirm you're happy with the added depth — or we trim (e.g., collapse each segment slider to 3
   presets: Light / AI / Heavy).

---

*No code until this spec is approved. Once approved, build on `dev` behind the toggle (Off = today's
board, unchanged), per the FW-59 dev-first + owner-gated-prod-promotion workflow.*
