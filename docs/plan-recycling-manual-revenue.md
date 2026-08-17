# Future Project — Manual Recycling-Revenue Entry (un-geofenced visits)

**Status:** BACKLOG / future project (captured 2026-08-16, owner). Not scheduled; not approved for build.
Assign an FW-## in the Future Work Register when picked up. Extends `docs/contract-recycling-revenue.md`.

## Problem
Recycling revenue is currently captured **only for geofence-derived visits**: `crewlogic-recycling` builds a
VISIT from a completed geofence dwell (`geofence_alerts` `event_type=geofence_exit`, `duration` not null)
joined to a revenue facility on `(franchise_id, provider_geofence_id)`, and the owner settles an `amount`
(+weight) per visit into `visit_settlements`.

**The gap:** if a truck **didn't trigger the recycling geofence** — device unplugged, GPS gap, the facility
isn't geofenced, or the dwell was too short to register — **no visit row is created**, so there is nowhere to
enter that trip's recycling revenue. That revenue silently goes uncounted. The owner needs a way to **manually
enter recycling revenue for a trip that has no auto-detected geofence visit.**

## Goal (one line)
Let the owner record recycling revenue for a recycling trip even when no geofence enter/exit was captured — so
the recycling revenue total reflects ALL trips, not just geofenced ones.

## Sketch of approach (to refine at build time)
- **Entry point:** the existing Recycling revenue screen gets an **"Add trip / manual entry"** affordance
  (alongside the auto-listed visits).
- **Data captured:** date, truck/route (or driver), facility (from the franchise's revenue facilities list),
  amount, optional weight — the same settlement fields, minus the geofence-visit backing.
- **Data model:** a manual entry needs a visit-equivalent with **no geofence source**. Options to weigh:
  (a) a synthetic "manual visit" row flagged `source='manual'`, settled the same way; or (b) a settlement
  that allows a null visit reference plus its own date/facility/truck metadata. Must flow into the recycling
  report identically, flagged as manual.
- **Reconciliation / no double-count:** if a geofence visit later appears for the same trip (delayed
  telematics), the manual entry and the auto visit must not both count. Need a merge/dedupe rule
  (by facility + date + truck within a window) or a manual "link to visit" action.

## Open questions (answer when scheduled)
1. Entry granularity — per trip, or a daily/facility lump sum?
2. How to pick the truck/route for a manual entry (dropdown of that day's routes? free text?).
3. Dedupe rule if the geofence catches up later — auto-merge by facility+date+truck, or leave to the owner?
4. Should manual entries be visually distinct in the revenue screen + report (they should — flag `manual`)?
5. Does this also cover facilities that are **never** geofenced (a standing "manual-only" facility mode)?

## First steps (when picked up)
1. Re-read `docs/contract-recycling-revenue.md` + the `visit_settlements` / `telematics_visits` schema
   (migrations 0056–0063) to confirm where a manual visit slots in without breaking the geofence join.
2. ✅ Contract addendum drafted — see **Addendum A** in `docs/contract-recycling-revenue.md` (manual-entry
   data model reusing `source='manual'`, the dedupe rule, UI, edge action). Awaiting owner sign-off.
3. Build on dev: schema (manual visit/settlement), `crewlogic-recycling` action (`saveManualVisit`), and the
   Recycling screen "Add trip" UI. Verify revenue report includes manual entries without double-counting.

## Related
- `docs/contract-recycling-revenue.md` — the approved geofence-visit revenue model this extends.
- Geofence source: `geofence_alerts` (Motive/Linxup) → visits; facilities keyed on `provider_geofence_id`.
- The recurring **unplugged-device** risk (a top cause of missed geofences) — see truck-marker states memory.
