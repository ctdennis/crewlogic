# UCB (Urgent Call-Back) Booking Contract — Sales Workspace (FW-66)

**Status:** DRAFT for owner sign-off. NO code until approved (contract-before-code).
**Scope:** scheduling a **UCB** from the Sales Workspace. Estimate + Leads + Cancellation contracts approved.
Case is the last contract. Author: 2026-08-15.

---

## What a "UCB" is
An **Urgent Call-Back** = an existing, **active** job/appointment parked on the special holding route
**"Pending-Other (URGENTCB)" (route relation objectID 2987)** — which is **NOT a real bookable route** (it's
not in `/resources/routes`; recognition is by that route relation — see [[vonigo-five-type-recognition]]).
It's a customer already in the system waiting to be **slotted onto a real route**. Row + recognition come
from the local job mirror (`pipeline_items type='ucb'` — 4 live on #90 today).

## "Book" a UCB = schedule it onto an available route (owner's spec)
> *"UCB operates more like a cancellation — all the information should be there, no commercial/residential
> lookup, no campaign source, just find a day and time and schedule it to an available route."*

So UCB is the **simplest** type — and simpler than cancellation:
- **No qualify step** (no res/commercial, no items entry).
- **No campaign source** (already set on the job).
- **No reactivation** (it's already active — unlike a cancellation) and **no cancel-trail** to clear.
- It's a straight **move/reschedule**: lift the existing WorkOrder off the URGENTCB holding route (2987) and
  drop it onto a real available route at a chosen day/time.

## The flow — reuse the existing `moveJob` spine
1. **Pick an available slot** — availability listing (`suggestSlots`) for the customer's zip → open slots on
   real routes; **duration from the zip lookup** (`/resources/zips/ method:1` → `ServiceTypes[0].duration`,
   see Leads contract).
2. **Lock the slot** — `/resources/availability/ method:"2"` → `lockID`.
3. **Move the WorkOrder** onto the new day/route/time — reuse **`moveJob`** (already exists:
   `{franchiseID, woID, dayID, routeID, startTime, durationMin, zip, serviceTypeID}` with the `lockID`),
   which relocates the WO from route 2987 to the chosen real route slot.
4. **Release the lock** (`method:"4"`) on any abort.
5. Workspace: item stage → **Won**.

## Inputs & where each comes from
| Field | Source |
|---|---|
| woID (+ jobID) | the UCB row (mirror `source_external_id` → the WorkOrder on route 2987) |
| client / contact / location / campaign / items | already on the job — untouched |
| new day / route / time | the chosen available slot (`suggestSlots`) |
| duration | zip lookup `/resources/zips/ method:1` → `ServiceTypes[0].duration` |

## Reuse vs. new
- **Reuse (exists):** **`moveJob`** (the whole reschedule/placement mechanism — proven on the dispatch
  board), availability lock (method 2) + release (method 4), `suggestSlots`, zip→zone→duration. **Zero new
  Vonigo primitives** — UCB is `moveJob` from route 2987 to a real route.
- **New:** just the workspace **"Schedule"** button + slot picker on a UCB item, wired to `moveJob` (a thin
  `bookUCB` wrapper for franchise-scoping/audit if we want parity with the other book actions). No qualify
  form, no campaign dropdown.

## OPEN ITEMS — build-verify only
1. **Status after the move** — confirm that moving a WO off the URGENTCB route sets/leaves status **Open/
   Booked** correctly (it should just become a normal booked appointment). Verify on the throwaway dev test
   (move a test UCB → confirm it lands as a normal booked job on the board → move it back).
2. **`moveJob` accepts a UCB WO** — confirm the WorkOrder on route 2987 is movable (active, not
   completed/archived, so no move-block). Same dev test.
3. **Writeback (parked, owner call):** mark the CrewLogic pipeline row scheduled/won and stop re-surfacing
   it? See [[bizdev-lost-outcome-vonigo-writeback]].

## Build sequence (on sign-off)
1. Throwaway dev test on #90: `moveJob` a real UCB (route 2987 → a real route slot), confirm it books
   normally, then move it back.
2. Client: workspace **"Schedule"** (UCB) → slot picker → confirm → `moveJob` (or `bookUCB`) → Won.
3. Verify on dev #90 with a real UCB (real Vonigo move), then restore, before promotion.

---
*No code until this contract is signed off. Case is the final contract.*
