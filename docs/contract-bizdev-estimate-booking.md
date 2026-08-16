# Estimate Booking Contract — Sales Workspace (FW-66)

**Status:** DRAFT for owner sign-off. NO code until approved (contract-before-code).
**Scope:** booking an **estimate** from the Sales Workspace. Leads / cancellations / UCB / cases are
separate contracts (next). Author: 2026-08-15, from the per-type walk-through.

---

## Vonigo semantics (what "book an estimate" means)
An estimate = a Vonigo **estimate-visit WorkOrder** with a **Quote** (the priced estimate). Booking it =
**Convert** → Vonigo creates the **"-2" sibling collection WorkOrder** (labeled *Estimate Converted*) with
the **charges copied** from the estimate. **"Do Work Now"** (crew, same-day) is a field menu action, **out
of scope** for bizdev — we assume larger jobs scheduled for another day. So bizdev has **one** book action:
**Convert**.

## Two entry situations
1. **Already in Vonigo** (an unconverted-estimate row in the pipeline): the quote already exists + is
   attached → **skip Attach**, go straight to Convert.
2. **CrewLogic-only costing** (not yet posted): **Attach first**, then Convert.

---

## Step 1 — ATTACH (situation 2 only) — ALL EXISTING PRIMITIVES
- **Attach:** `crewlogic-estimate` `action:'submitQuote'` with the `jobID` → posts the priced estimate onto
  the Vonigo job (the estimate visit). (This is today's "Attach to Job" button.)
- **Collision:** if the job already has an estimate, `submitQuote` returns the *"already assigned"* error.
  Workspace prompts **"This job already has an estimate — replace it?"** → on confirm:
  - **Delete existing:** `crewlogic-estimate` `action:'delete'` → `POST /data/Quotes/ {securityToken, method:"4", objectID:<quoteID>}` (confirmed).
  - **Re-attach:** `submitQuote` again.
  All in the workspace — no bounce to Vonigo.

## Step 2 — BOOK = CONVERT — ONE NEW PRIMITIVE (the lock)
a. **List availability** — REUSE `crewlogic-dispatch` `suggestSlots` (`/resources/availability`, listing)
   for the customer's zone + `serviceTypeID:11` + `duration` → open slots (each has `dayID`, `routeID`, `startTime`).
b. Manager **picks a day/time** in the workspace slot picker.
c. **LOCK the slot (NEW):** `POST /resources/availability/ method:"2"` (location variant):
   `{securityToken, method:"2", dayID, routeID, locationID, serviceTypeID:"11", duration, startTime}` → returns **`lockID`**.
   *(Zone variant: `zoneID` instead of `locationID`.)*
d. **CONVERT:** `POST /data/Quotes/ {securityToken, method:"2", quoteID, lockID}` → creates the "-2"
   collection WO, charges copied.
e. **RELEASE the lock on ANY abort** (convert fails, or the manager cancels after locking):
   `POST /resources/availability/ {securityToken, method:"4", lockID}` → frees the held slot so it isn't
   left blocked. On a *successful* convert the lock is consumed — only release on the unhappy path.
f. Workspace: item stage → **Won** → drops off the active list.

## Inputs & where each comes from
| Field | Source |
|---|---|
| `quoteID` | the estimate's Vonigo quote id (`source_external_id` / on the estimate) |
| `locationID` | the estimate's Vonigo location |
| `routeID`, `dayID`, `startTime` | the chosen slot from the availability listing |
| `serviceTypeID` | `11` (Junk Removal) |
| `duration` | the **zone's** service duration (zip → zone → duration) |

## Caveats / handling
- **Lock lifecycle:** the `lockID` HOLDS the slot → **lock → convert must be tight** (one server-side
  action). On success the lock is consumed. On ANY failure or cancel, **release it**
  (`/resources/availability` method 4 + `lockID`) so the slot isn't left blocked. If convert fails "lock
  expired," re-lock the same slot and retry once.
- **Live price re-read:** before booking, re-read the estimate's **current** quote total live (not the
  cached `pipeline_items` number) so the booked charges reflect any last-minute adjustment. (This is why
  "Vonigo = booking source of truth, live re-read on open/before-book" is the design rule.)
- **Method numbers:** availability-lock = **2**, availability-**release** = **4**, quote-convert = **2**,
  quote-delete = **4** — all confirmed (owner + existing `crewlogic-estimate` code). Vonigo's published enum
  under-lists them. NOTE two different method-4s on different endpoints: `/data/Quotes` 4 = *delete quote*;
  `/resources/availability` 4 = *release lock*.
- **Irreversible in Vonigo:** conversion is real — the dev build must be tested against a throwaway
  estimate on #90 before anyone books a live one.

## Reuse vs. new
- **Reuse (exists):** `submitQuote`, quote `delete` (method 4), `suggestSlots` / availability listing,
  zip→zone→duration lookup.
- **New:** the **lock** call (`/resources/availability` method 2 → `lockID`), the **convert** call
  (`/data/Quotes` method 2), and the **release** call (`/resources/availability` method 4) on the unhappy
  path — wired into a single franchise-scoped, audited **`bookEstimate`** edge action (in
  `crewlogic-dispatch` or `crewlogic-estimate`) that runs: `[attach + collision-handle if needed] → lock →
  convert; release-lock on any failure/cancel`. Plus the workspace slot-picker UX and wiring "Schedule /
  book" to it.

## Build sequence (on sign-off)
1. Edge `bookEstimate` action (attach/collision reuse → lock → convert), franchise-scoped + audited, dev.
2. Client: workspace "Schedule / book" (estimate) → slot picker (availability) → confirm → `bookEstimate`
   → Won. Live price re-read on open.
3. Verify on dev #90 with a throwaway estimate (real Vonigo write) before promotion.

---
*No code until this contract is signed off. Leads contract is next.*
