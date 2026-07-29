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

One joystick, not a controller full of buttons. The **entire** primary UI is:

- **ONE control** — a slider that turns the view on/off **and** sets the forecast lean.
- **ONE occasional button** — Refresh, which only appears when something changed.

Everything else responds automatically. Crew-feedback edits are on-demand taps, not permanent controls.

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

## 5. The single control

**Recommended:** a slider with an **"Off" detent** at the far left.

```
[ Off ●──────────── ]   today's view, no AI
[ Off ────●──────── ]   Light  (everyone's low guess)
[ Off ──────────●── ]   Heavy  (everyone's high guess)
```

- Far-left detent = **Off** (no AI, today's view).
- **Light → Heavy** sweeps the *forecast lean* = where in each job's `[low, high]` the estimate sits
  (Light = low, Heavy = high, center = midpoint).
- Dragging off the detent turns the view on (fires the first AI pass); slamming back to Off hides it and
  stops all AI.

**Fallback:** a toggle pill + a slider that only appears when on (cleaner to explain, but two controls).

The volume slider is the **twin of the existing finish-speed dial** — same "drag to stress-test" gesture,
different axis. It shows only in AI mode (progressive disclosure), so Off = today's single-dial board.

## 6. What it shows

- A **per-route fill bar** that fills green → amber → red across the day; a single **pin** dropped where
  it crosses 100%.
- Drag the slider → the pin **slides** (heavier → fills sooner, lighter → later, or disappears if it
  never fills).
- One plain sentence, e.g. *"Route 4 fills ~1:00 PM → dump before Camara (4 PM)."*
- Per-job volume numbers live on **tap/hover**, not on the board face (resist clutter).

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

## 9. Crew actuals — the pin bends to reality (free)

The AI gives a *forecast*; the crew gives *facts*. Both feed the same fill line:

- The **slider forecasts only jobs not yet done.**
- **Tap a job → "what actually happened"** → set the real fill the crew reports (predicted ½, they
  consolidated to ¼ → set ¼). That segment **locks to the actual**, the slider stops affecting it, and
  the pin recomputes instantly (no AI).
- Fill bar: **done jobs solid (actual)**, upcoming jobs **hollow/hatched (forecast)**. Through the day,
  forecast → actuals, the pin **sharpens**, with zero extra AI. (Progressive certainty.)

## 10. Estimate-Only (EO) jobs — default out, convert on a tap

- EO jobs **default to 0 / not counted** (matches "we train teams to convert on the spot — start with no").
- If the crew converts on-site: **tap → "converted"** → it counts. Since the crew is standing in the
  unit, they'll usually hand you the **actual** — so a conversion typically needs **no AI**, just the
  same set-actual tap. (AI's value is the morning forecast; live conversions are better served by real
  numbers than a prediction.)

## 11. Truck capacity

- **Default 16 cu yd.** Editable in **Settings → Cost Analysis.** Single global number for v1.
- Per-truck sizes: later refinement (see §14).

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
- Off-detent slider (on/off + lean)
- AI-once cached per-job estimate (`summary + items` → `{low, high}`), keyed by `woID + descHash`
- Per-route fill bar + single unload pin
- Per-job "set actual" tap (crew feedback)
- EO default-out + "convert" tap
- Description-hash staleness + Refresh (pay only for new/changed jobs)
- Truck-capacity setting (16 cu yd, Settings → Cost Analysis)

**LATER:**
- Route the unload pin to the nearest facility / empty-can and fold its drive time into the ETA (reuses
  the existing disposal-finder + facilities) — deferred because it starts merging Layer 0 and Layer 1
- Per-truck capacity
- Auto-calibrated default lean from stored actuals (§13)
- Predicted-vs-actual accuracy reporting

## 15. Open decisions

1. **Where "set actual" lives** — a tap on the fill strip, or reuse the existing board job popup (zero
   new surface). *Lean: reuse the popup.*
2. **Cancels / day-moves** — auto-update the pin silently, or also show a "schedule changed" note. *Lean:
   silent for removes; note only for adds/edits.*
3. **Estimate cache storage** — small relational table (recommended) vs lightweight blob on the day's
   state.
4. **Single off-detent slider vs toggle + slider.** *Lean: off-detent.*
5. **Billing unit** — per-job-read (recommended) vs flat per-refresh.

---

*No code until this spec is approved. Once approved, build on `dev` behind the toggle (Off = today's
board, unchanged), per the FW-59 dev-first + owner-gated-prod-promotion workflow.*
