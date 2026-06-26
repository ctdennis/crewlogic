# Plan — Desktop Dispatch Dashboard

**Status:** DRAFT for Owner approval (brainstormed 2026-06-26). No code until approved.
**Audience:** all desktop users. **Strategic fit:** ops-depth moat vs QuoteIQ — a multi-pane dispatch
cockpit (live trucks + two-day schedule + cross-day job moves) that QuoteIQ has no equivalent of.

---

## Goal

A **desktop-oriented dashboard** that shows several CrewLogic features at once as "portlets," so an
operator can dispatch from one screen. The flagship workflow: **see two days' schedules side by side
(source + destination), with the live trucks map for context, and move jobs between days** using the
existing **voice/AI** command flow **and** drag-and-drop — landing a job on a specific **route + time
slot** on the destination day. Vonigo's drag-drop is **single-day only**; doing it **across two days**
is the differentiator.

---

## Architecture decisions (locked in brainstorm 2026-06-26)

1. **Build inside `index.html` — NOT a separate surface yet.** The dashboard's value is *reusing* the
   existing map, schedule, voice/AI-move pipeline, pricing, auth/session. All of that is vanilla JS in
   the monolith. A separate surface (esp. a framework) would force either duplicating that logic
   (divergence) or modularizing the 22k-line file + a build step — premature before presets prove demand.
2. **The dashboard is ONE top-level screen** (`dashboardScreen`, desktop-only). The single-screen
   navigation model (`hideAll()` + `show*`) is unchanged at the top level; the multi-pane complexity
   lives *inside* that screen. This keeps the blast radius small.
3. **Presets first, not configurable portlets.** Start with fixed layouts (e.g., a "Dispatch" preset).
   Add/remove/drag/resize is deferred (Phase 3).
4. **Reuse, don't duplicate.** Portlets call the *same* feature renders — which requires decoupling
   those renders from full-screen DOM ids + module globals (the keystone refactor).
5. **No new backend except one call.** Reuses `crewlogic-dispatch` (listRouteJobs, moveJob,
   availability), `crewlogic-trucks`, `crewlogic-todays-workorders`, and the voice pipeline. The only
   new Vonigo call is **`/data/BookOffs`** (blocked-time data) for the availability board.
6. **Separate-surface trigger (future):** revisit *only* when committing to full configurable portlets
   (Phase 3). At that point: modularize shared logic → then a framework + grid lib (e.g.,
   react-grid-layout). Not before.

---

## Phase 0 — Availability-aware schedule board (KEYSTONE; also fixes a live bug)

**Why first:** drag-to-slot is unsafe without knowing blocked vs open vs occupied, and the current board
only renders **routes that have jobs** (`listRouteJobs` → `byRoute` from jobs; index.html ~7915). It
never fetches all active routes, the open-availability grid, or BookOffs — so **empty routes vanish** and
**blocked time looks open** (owner-reported 2026-06-26, Sat 6/27 vs Vonigo). Fixing this ships value to
the **existing Manage Jobs board** immediately and is the component the dashboard composes.

**Target render:** all **active routes as rows × a time grid**, three layers:
- **Occupied** — jobs (today's behavior).
- **Blocked (gray)** — two flavors, both handled: a **fully-closed route** (`isActive=false` from
  `/resources/routes`, or a full-day BookOff) → all-gray row; **partial time-blocks** (BookOffs) → gray
  bands within an active route. Mirrors Vonigo's gray bands.
- **Open** — droppable availability.

**Backend (light–moderate):** assemble a per-route/per-day grid from `/resources/routes` (all active,
already wired in crewlogic-dispatch:178), `/resources/availability` method 0 (open slots, already wired),
**+ `/data/BookOffs` (NEW — the one new call; recon done).** Likely a new/extended `crewlogic-dispatch`
action (e.g., `boardGrid`).

**Frontend (bigger piece):** upgrade the board from "jobs grouped by route" to a real routes×time grid
with the 3 layers (+ drop targets, used in Phase 2).

**TZ care:** availability `startTime` = **minutes-from-franchise-local-midnight** (720 = noon) — render
in the franchise's timezone (multi-tenant TZ discipline).

**Scope:** the full 3-layer grid applies to the **standalone Manage Jobs board** now, not just the
dashboard (owner-confirmed).

---

## Phase 1 — Desktop Dispatch dashboard (presets, read+voice)

- New **`dashboardScreen`**, offered on desktop widths (mobile keeps current screens untouched — viewport
  branch + preservation guard).
- **"Dispatch" preset** (the #1 layout): **Where Are My Trucks (map)** beside a **source-day board** and
  a **destination-day board**. Destination day is **user-settable** (date picker on that pane).
- **Re-entrant board component** (the keystone refactor): day + container + isolated state, so two boards
  run concurrently without colliding on globals. Reuses the Phase-0 grid render.
- Layout via **CSS grid**; chosen preset persisted as a small JSON on the profile.

---

## Phase 2 — Cross-day moves: drag-to-slot + voice (one confirm gate)

- **Both** drag-and-drop **and** the existing voice/AI command funnel through **one source→destination
  confirmation modal** before committing. The modal states: job, **source date**, **destination date +
  route + time slot**; warns on conflict/availability. **Confirm-first**, not optimistic (a "pending"
  ghost shows in the target slot; commit only on confirm; then re-render both boards).
- **Drop target = day + route + slot** (Vonigo schedules by route × time). Drop onto a specific route at a
  specific time on the destination board.
- **Conflict handling:** warn-and-allow (Vonigo permits manual placement) — surfaced in the confirm modal.
- Reuses the **already-built `moveJob`** engine + availability (the voice flow is already day-aware). Drag
  is just a second trigger for the same action — **no new dispatch logic, no new backend.**

---

## Phase 3 — Deferred: configurable portlets

Full add/remove/drag/resize + per-user persisted layouts. Revisit the **separate-surface** decision here
(modularize → framework + grid lib). Only if customers actually ask to rearrange.

---

## Reuse map

| Need | Existing piece |
|---|---|
| Live trucks map | `crewlogic-trucks` (per-franchise) + the Leaflet render |
| Day schedule (jobs) | `crewlogic-dispatch` `listRouteJobs` |
| All routes / open slots | `crewlogic-dispatch` `/resources/routes`, `/resources/availability` |
| **Blocked time (NEW)** | Vonigo `/data/BookOffs` |
| Move a job (incl. cross-day) | `crewlogic-dispatch` `moveJob` + voice pipeline (day-aware) |
| Confirm-before-mutate | the existing voice command→confirm→execute flow |

---

## Challenges / risks

- **Re-entrant board refactor** (decouple from globals/full-screen) is the keystone and the main
  regression risk to the mobile app — guard the existing screens (preservation/regression discipline).
- **TZ correctness** on the availability grid (minutes-from-local-midnight; render per franchise TZ).
- **Concurrent fetch/refresh** across panes (map 45s refresh + two day-boards) — share data, avoid
  redundant calls. Tuning, not a blocker.

---

## LOE summary

- **Phase 0:** moderate. Backend = assemble existing calls + add BookOffs. Frontend = real availability
  grid. Ships standalone value (fixes the blocked/empty-route bug).
- **Phase 1:** moderate. Mostly the re-entrant board + desktop layout/entry. No backend.
- **Phase 2:** moderate. Drag layer + unified confirm modal on the existing move engine. No backend.
- **Phase 3:** heavy (framework + portlet system). Deferred.

---

## Open items to confirm before build

- [ ] Confirm-modal exact contract (fields shown; conflict-warning copy).
- [ ] Voice mental model when both boards are visible (does "move the 2nd job to tomorrow at 10" auto-
      target the destination board?).
- [ ] Desktop entry UX (toggle vs auto-offer on wide screens) — kept streamlined.
- [ ] Drop snapping (nearest open slot vs exact drop position).

---

_Origin: Owner brainstorm 2026-06-26. Sibling: `plan-voice-dispatch.md` (the move engine this reuses)._
