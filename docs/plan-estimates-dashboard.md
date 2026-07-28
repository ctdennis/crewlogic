# Plan — Estimates Dashboard (estimates + schedule on one page)

**Status:** DRAFT for Owner approval (2026-06-28). No code until approved.
**Goal:** Estimate and schedule on **one desktop screen** — no jumping to Vonigo or the ops dashboard to
schedule a booked estimate. Estimates list on the left, the full estimate feature in a wider pane, a live
schedule board, and (easy path) the Junkluggers Google Calendar as a top lane.

**Origin:** Owner 2026-06-28 — "when an estimate books I have to jump out to Vonigo or the dispatch
dashboard to schedule… get the list of estimates on the left with the schedule on the right, same page."

---

## Owner-confirmed decisions
1. **Estimates list:** show the **last 5**, with a **filter/lookup** to pull any estimate (past or recent).
2. **Estimate pane:** the **full existing estimate feature**, ported into the wider window. Stretch: **double-click a schedule slot → create a new Vonigo job** (untested — see Phase 3).
3. **Price lookup:** OUT for round 1.
4. **Layout:** simple first (list left / board right on desktop), iterate later. Designer's call.
5. **Google Calendar:** IN — via the **easy iCal** path.

---

## What's reusable (from the 2026-06-28 code recon)
- **Schedule board** — `mjRenderBoard(data, container, axis)` + `boardGrid` are already **re-entrant**
  (two run side-by-side on the dispatch dashboard). Drop one in with its own container. **(low)**
- **Estimates list** — `initEstimatesList` / `renderEstimatesList` already query `estimates` (owner-scoped,
  `order=updated_at.desc`) and already filter by status + name/address. Add `limit=5` + a lookup input. **(low)**
- **Estimate feature** — `estimateEditorScreen` + `openEstimateEditor()` populate ~20 fixed DOM IDs; the math
  (`updateTotals`, `renderCharges`) is modular. Port by **relocating the `estimateEditorScreen` node into the
  dashboard pane** (same trick as `#mjTip`) so existing code works as-is; decouple IDs only if needed. **(moderate)**
- **iCal** — no existing calendar code. New small edge fn fetches + parses the `.ics`; render as a board lane. **(low-mod)**

---

## Phases (dev-first; gated prod promotes as usual)

### Phase 1 — the one-page core (the "no switching" win)
- New desktop screen **`estimatesDashboardScreen`** (desktop-only, like the dispatch dashboard).
- **Left:** estimates list — last 5 + a lookup/filter (client/address/status) to pull any estimate.
- **Right:** a **schedule board** (the re-entrant board) with a day picker — view the day's routes/jobs/open slots.
- **Estimate pane:** open an estimate into the wider pane (relocated editor) — full existing features.
- Result: estimate + schedule visible together; book in the estimate feature, see the schedule right there.
- Effort: **moderate** (mostly the estimate-pane port). No backend change.

### Phase 2 — Google Calendar (iCal) top lane
- Settings: paste the calendar's **secret `.ics` address** (per franchise; stored carefully, not in code).
- New edge fn **`crewlogic-calendar`** — fetch + parse the `.ics`, return events for the day.
- Render events as a **top lane** on the schedule board (time-aligned, like a route lane).
- Effort: **low-moderate**. New edge fn + a lane renderer.

### Phase 3 — double-click slot → create a Vonigo job (gated on a spike)
- **Spike first (~1-2h):** confirm Vonigo **`/data/WorkOrders/` method 3 (create)** — we have method-3
  *create* proven for Quotes and *lock+move (method 16)* proven for WorkOrders, but **WorkOrder create is
  unproven**. ⚠ dev + prod share #90's **live** Vonigo, so the spike creates a **real** job — do it with a
  dry-run if supported, else a clearly-labeled test job we delete.
- If the spike succeeds: double-click an open slot → confirm modal → create the WorkOrder → lock + place it
  (proven move code). Effort then **low-moderate** (~a new `execute` kind:'create').
- If it fails / is too risky: fall back to opening the estimate's existing **submitQuote** path (which already
  creates a Vonigo quote) and/or a deep link — no dead end.

---

## Open questions for Owner
- **Phase order:** 1 → 2 → 3 (my rec — ship the no-switching core first), or fold the calendar (2) into the
  first release?
- **Create-job spike:** OK to run the Vonigo WorkOrder-create spike (it touches live Vonigo — I'll use a
  dry-run or a labeled test job I remove)? Or keep Phase 3 out until you want it?

---

## Risk / notes
- Desktop-only (mobile keeps the existing estimate + schedule screens — preservation/regression guard).
- No DB migration for Phase 1. Phase 2 stores the `.ics` URL in settings. Phase 3 may add an `execute`
  action to `crewlogic-dispatch` (gated prod deploy).
- Estimate-pane port is the main Phase-1 risk (decoupling from full-screen IDs); the relocate-the-node
  approach keeps it low if the editor renders acceptably in a narrower pane.

_Closes once Phase 1 ships + Owner confirms the one-page workflow._
