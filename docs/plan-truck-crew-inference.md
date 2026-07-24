# Plan — Truck Crew Inference + Tip-Split Warning

**Status:** APPROVED 2026-07-24 (defaults D1–D5). **Phase 1 BUILT on dev (v5.88.0)** — edge action
`crew-infer` + truck-popup readout + tip-split/no-crew warnings. Logic validated on prod read-only SQL;
**visual test is PROD-only** (dev has no `job_arrive` data). Ships with the geofence/colors promo bundle.
Phase 2 (live alert) not started.
**Owner:** charles.dennis@junkluggers.com · **Scope:** CrewLogic trucks map / truck detail (+ optional live alert)

---

## 1. Problem / value

Vonigo assigns crew to **jobs (WorkOrders)**, not to trucks. So when you click a truck on the
map there's no direct "who's on it." Two real needs:

1. **Readout** — "who is likely on this truck today," inferred from the jobs it worked.
2. **Tip-split warning (the important one)** — a crew that physically works a job it isn't
   *assigned* to in Vonigo gets **no share of that job's tip** (tips split only among assigned
   crew). Catching that mismatch *before* tips are calculated is the payoff.

## 2. Data — already captured, no new tracking

- **Truck → jobs it worked today:** `geofence_alerts` `event_type='job_arrive'` events per
  `vehicle_number` → `wo_id`. These are **real dwells** (the geofence already excludes sub-8-min
  drive-bys), so an arrival = an actual stop.
- **Job → assigned crew:** `job_source_snapshot.crew_display` (`[{id,name,title}]`, names as
  `"Last, First"`). Verified on the mirror: **234 / 363** jobs carry crew (e.g. `Wheeler, Austin`,
  `Dennis, Carter`); ~35% have none (a Vonigo assignment gap — the warning surfaces it).
- **Route + client/address** for display: already on the snapshot / job rows.

## 3. Inference algorithm (per truck, today, franchise-scoped)

**Step 1 — Visited jobs.** Collect the `wo_id`s the truck (`vehicle_number`) arrived at today
(job_arrive since franchise-local midnight).

**Step 2 — Infer the truck's crew.** Over the truck's visited jobs *that have crew assigned*,
tally each person's appearances. The truck's crew = people appearing on ≥ **THRESHOLD** of those
jobs (default 60%). Confidence:
- **HIGH ("Likely")** — visited jobs cluster on **one route**, ≥2 jobs, a **consistent** crew set,
  and that set doesn't materially overlap another truck's inferred crew.
- **LOW ("Possibly")** — visited jobs span **≥2 routes**, OR the crew set overlaps another truck's
  crew (can't cleanly attribute).
- **UNKNOWN** — none of the truck's visited jobs have crew → "can't determine crew" (no false alarm).

**Step 3 — Tip-split mismatch (per visited job).** Compare the job's assigned crew (`crew_display`)
to the truck's inferred crew:
- Truck's crew has members **not** on the job's assignment → **mismatch**: those people were present
  (real dwell) but won't be tip-credited → flag the job.
- Job has **no crew at all** → "no crew assigned" flag (the plain warning).
- Correct even for legitimate help: if the crew really helped, the fix is the same — add them in Vonigo.

## 4. Output / copy (truck detail box)

Proposed lines (wording open to your edit):

- **High:** `Truck 2 · Crew (likely): Wheeler, Austin & Dennis, Carter — 7 jobs, route MA3ALL`
- **Low:** `Truck 2 · Crew (low confidence): possibly Wheeler, Austin; Simmons, Adyn — covered 2 routes today`
- **Unknown:** `Truck 2 · Crew: can't determine (no crew assigned on today's jobs)`
- **Tip-split warning:** `⚠ Truck 2's crew was at 2 jobs they're not assigned to — add them in Vonigo so tips credit them: Job 1 (DiSilvia), Job 5 (Smith)`
- **No-crew warning:** `⚠ N of this truck's jobs have no crew assigned in Vonigo: Job 3 (Reber)…`

## 5. Where it surfaces

- **Phase 1:** the truck **detail box** (`_railShowInfo`) on click — readout + both warnings.
- **Phase 2 (optional, recommended):** the tip-split mismatch is **time-sensitive** (fix before
  tips are calculated), so also surface it as a **live alert** — "Truck 2 dwelled at Job 1, assigned
  to a different crew." Decide in Phase 2; not baked into Phase 1.

## 6. Implementation notes

- Compute in a **service-role edge function** (token-independent, franchise-scoped by
  `franchiseInternalID` — same model as `crewlogic-jobs` / `crewlogic-geofence-alerts`). Likely a
  new action on `crewlogic-geofence-alerts` (`action:'crew-infer'`) or a small new function.
- Input: `{ franchiseInternalID, date? }`. Output: per-`vehicle_number` `{ crew:[…], confidence,
  routes:[…], jobCount, mismatches:[{wo_id, client, missing:[…]}], noCrew:[{wo_id, client}] }`.
- Client calls it when the trucks map / a truck detail opens; cache per render cycle.
- Read-only. No writes to Vonigo.

## 7. Open decisions (defaults proposed — override any)

| # | Decision | Proposed default |
|---|---|---|
| D1 | Time window | **Today** (arrivals since franchise-local midnight) |
| D2 | "Likely" threshold | Person on **≥60%** of the truck's assigned jobs; ≥2 routes ⇒ downgrade to Low |
| D3 | Show crew **titles/roles** (driver/helper)? | **Names only** in Phase 1; titles optional later |
| D4 | Tip-split as a **live alert** too? | **Phase 2** (Phase 1 = truck detail only) |
| D5 | Name format | As stored: **`Last, First`** |

## 8. Edge cases

- Truck with no arrivals yet → "no jobs visited today."
- Multi-truck job → each truck's crew inferred from **its own** assigned jobs; the mismatch warning
  correctly flags any truck whose crew isn't on that job's assignment.
- Mid-day crew swap → per-job comparison handles it (a one-off different-crew job reads as low weight / mismatch).

## 9. Out of scope (v1)

- Editing Vonigo crew assignments from CrewLogic (v1 warns; the fix happens in Vonigo).
- Historical crew analytics / payroll export.
- Cross-day crew tracking.

---

**Sign-off:** approve as-is, or edit the copy (§4) / decisions (§7) and I'll build Phase 1 on dev.
