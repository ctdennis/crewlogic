# Cancellation (Win-Back) Booking Contract — Sales Workspace (FW-66)

**Status:** ✅ APPROVED-IN-APPROACH 2026-08-15 (owner chose **Path A — reactivate**, and reactivation MUST
land on a **new day/time**, never the original slot). Build authorized; a throwaway dev reactivate pins the
exact status/slot mechanism first (as with Leads). NO other code until then (contract-before-code).
**Scope:** re-booking a **cancellation** from the Sales Workspace. Estimate + Leads contracts approved.
UCB / case are separate contracts (next). Author: 2026-08-15.

---

## What a "cancellation" is
A pipeline **cancellation** = a Vonigo job whose appointment was cancelled: WorkOrder **status field 181 =
"Cancelled" (162)** or **"Cancelled-Today" (163)**, and Job **status field 984 = "Cancelled" (9942)**. The
job is **inactive** (`isActive:false`) but **everything is preserved** — verified on a real cancelled job:
- Relations intact: **client, contact, location1, job, route, zone**.
- Job fields intact: **campaign (969)**, plus the cancel trail **973 Cancellation Notes / 974 Cancellation
  Stage / 975 Cancellation Reason**, charges/quotes preserved.
- Recognition + the row itself come from the local job mirror (`pipeline_items type='cancellation'`) — see
  [[pipeline-sources-from-job-mirror]]. (The mirror's `source_external_id` is the **Job id**; retrieve the
  job via `/data/Jobs/ method:-1`, and reach its appointment through the job's WorkOrder relation —
  `/data/WorkOrders/ method:-1 objectID` is unreliable and can return a wrong record.)

## "Book" a cancellation = WIN IT BACK (re-schedule the customer)
Because the customer already exists with full history, re-booking is the **easiest** of all the types — no
qualify step, all details known. **Two mechanisms; the cancelled WO reports `isCanActivate:true`, so Vonigo
supports reactivation:**

### Path A (APPROVED) — reactivate the ORIGINAL job INTO A NEW DAY/TIME
Preserves the job, its charges, campaign, and history (a true win-back, one continuous record). **The
original slot is never reused — the manager always picks a new day/time; reactivation and reschedule are ONE
operation.**
1. **Pick a NEW slot** (a different day/time) — availability listing, reused from `suggestSlots`; duration
   from the zip lookup. (Owner: "if we reactivate, we reactivate for a different day and time.")
2. **Lock the slot** — `/resources/availability/ method:"2"` → `lockID`.
3. **Reactivate + reschedule** the existing WorkOrder INTO the locked new slot in one go: flip status **181
   Cancelled(162) → Open(160)** AND set the new day/route/time. Mechanism to confirm at build (one throwaway
   dev reactivate): either a native **activate** action (implied by `isCanActivate:true`) combined with a
   move, or a WO **edit (method 2)** that sets status 181 + the new slot together — then **clear the cancel
   trail** (973/974/975) and set Job 984 → Open. Reuses the move/reschedule spine (`moveJob` already places a
   WO on a slot with `lockID`).
4. **Release the lock** (`method:"4"`) on any abort.
5. Workspace: item stage → **Won**.

### Path B (fallback ONLY) — fresh job (the Leads spine)
Not the chosen approach. Kept only as a per-job escape hatch: if a specific job **cannot** be reactivated
(Vonigo refuses `isCanActivate`), fall back to **creating a new appointment for the same client** via the
approved **Leads** flow (client known → zip duration → lock → `WorkOrders method:3` → set campaign 969),
leaving the cancelled job as history. Default is always Path A.

## Inputs & where each comes from
| Field | Source |
|---|---|
| jobID / woID | the cancellation row (mirror `source_external_id` = Job id) → job's WO relation |
| client / contact / location | already on the cancelled job (no re-entry) |
| campaign (969), charges | already on the job — carried forward as-is |
| new day / route / time | the chosen slot (availability listing) |
| duration | the **zip lookup** `/resources/zips/ method:1` → `ServiceTypes[0].duration` (see Leads contract) |

## Reuse vs. new
- **Reuse (exists):** availability lock (method 2) + release (method 4), `suggestSlots`, `moveJob`
  (reschedule/placement), zip→zone→duration, the whole Leads spine (for Path B). `cancelJob` is the inverse
  primitive (status → Cancelled) and a reference for how the status field is written.
- **New:** a **`rebookCancellation`** edge action — Path A: `[lock slot → reactivate WO (status 181→Open) +
  reschedule to slot → clear 973/974/975, Job 984→Open → release lock on abort]`; franchise-scoped + audited.
  Plus the workspace "Re-book / win-back" button + slot picker (no qualify form needed — details known).

## OPEN ITEMS — build-verify only (approach is settled)
1. **Exact reactivate mechanism** — dedicated Vonigo **activate** call vs a WO **edit (method 2)** that sets
   status 181 → Open **together with** the new day/route/time. (`isCanActivate:true` confirms it's allowed.)
   Settle with ONE throwaway dev reactivate on a test cancellation (reactivate to a new day/time → confirm on
   the board → re-cancel).
2. **Cancel-trail hygiene (default: YES, clear it)** — on win-back, clear 973/974/975 and set Job 984 → Open
   so the record doesn't read as both cancelled and active. Will confirm the "Open/active" Job-984 optionID
   during the dev test. (Flag if you'd rather KEEP the cancel notes for history.)
3. **Writeback (parked, owner call):** on a successful win-back, also mark the CrewLogic pipeline row
   recovered/won (stop re-surfacing it)? See [[bizdev-lost-outcome-vonigo-writeback]].

## Build sequence (on sign-off)
1. Throwaway dev reactivate on #90 to pin the exact status/slot mechanism (Path A), then re-cancel.
2. Edge `rebookCancellation` action (lock → reactivate + reschedule → clear cancel trail → release on abort),
   franchise-scoped + audited, dev.
3. Client: workspace "Re-book / win-back" (cancellation) → slot picker → confirm → `rebookCancellation` → Won.
4. Verify on dev #90 with a throwaway cancelled job (real Vonigo write), then re-cancel, before promotion.

---
*No code until this contract is signed off. UCB contract is next.*
