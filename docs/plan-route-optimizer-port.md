# Plan — Route Optimizer: n8n Retirement + Port Reference

**Status:** REFERENCE + pre-cancellation checklist · 2026-07-20
**Why this exists:** Owner is cancelling the n8n subscription. The route-optimization engine is the last live n8n dependency (FW-42). This document captures everything needed to (a) restore the workflow in a future n8n instance, or (b) rebuild it natively in CrewLogic — so neither path depends on the subscription still existing.
**Sources:** full analysis of `docs/Route Optimization.json` (69 nodes, 272KB, exported 2026-07-05) + the unredacted local sibling.

---

## 1. DO THIS BEFORE CANCELLING ⚠️

Once the subscription lapses these become unrecoverable:

- [x] ~~**Export all three Google Sheet tabs**~~ — **DONE 2026-07-20.** `TS_Costs.csv` (29 rows), `Wait_Times_Lookup.csv` (137), `Volumes.csv` (65) + `TS_Costs_variant_hours.csv` are in `docs/route-optimizer-data/`, pulled via the Drive connector. Note: the sheet lives in **charles.dennis@junkluggers.com**, not tpass2008. Also note the urgency here was overstated — the sheet is in Owner's own Drive and is unaffected by cancelling n8n; this is a convenience snapshot, never a hard dependency.
- [ ] **Screenshot the n8n credential list** — you need to know what to recreate: `Slack account 3`, `Google Sheets - Main Account`, `Anthropic account 2`.
- [ ] **Keep `docs/Feature-StandaloneMode/n8n-workflows/Route Optimization (3).json`.** It is gitignored (`.gitignore:9`) and was never committed, so its live keys never left the machine — but it is now the ONLY copy holding the real Google Sheet ID and inline API keys, which the 2026-07-05 scrub replaced with `MY_*` placeholders in `docs/Route Optimization.json`. Do not delete it; do not commit it.
- [ ] **Note the n8n instance URL** — `https://junkluggers.app.n8n.cloud/webhook` (`index.html:4155`).

## 2. What breaks on cancellation

**Exactly one thing.** Verified by grep, not assumption:

| Call site | Feature | Scope |
|---|---|---|
| `index.html:13126` — `apiFetch(N8N_BASE + '/crewlogic-route')` | Route Optimizer screen | **Franchise 90 only** (`routerCard` is gated to `franchiseID === '90'`, index.html ~7948) |

Everything else migrated to edge functions already. The workflow's second webhook (`crewlogic-trucks`) was superseded by the edge function of the same name and is dead weight.

**Recommended pre-cancellation change:** either hide `routerCard` or make the failure explicit ("Route Optimizer is offline"). Today a dead `N8N_BASE` produces a raw fetch error in the UI. Not doing this is survivable — it is your franchise and you know why it broke — but it will be confusing later.

**Not affected:** the "Find disposal" feature on the dispatch dashboard. That is `crewlogic-route-disposal`, a native edge function, and it already implements the single-stop cheapest/fastest disposal ranking. n8n is not involved.

## 3. Restoring in a future n8n instance

The JSON imports cleanly — 69 nodes plus connections, `pinData` empty. It will not RUN without:

1. **Three credentials recreated + re-authorized.** n8n exports never contain credential secrets, only references by name. The Google Sheets one is OAuth2, so a real re-consent.
2. **The Google Sheet**, with the same tab names. If the ID changed, update all 9 `documentId` references.
3. **Inline API keys** — Google Maps, Motive, Anthropic. Present in the unredacted copy; `MY_*` placeholders in the scrubbed one.
4. **Vonigo credentials** — the workflow logs in directly via `/security/login/`, reading `$json.credentials.{company,username,password}`.
5. **`N8N_BASE` updated** in `index.html:4155` to the new instance host.

## 4. The algorithm — what it actually does

**Key finding: the logic is in the code, not the LLM prompt.** ~1,500 lines of deterministic JavaScript across 34 code nodes. A rebuild is a PORT, not a re-derivation.

Pipeline from `POST /crewlogic-route {truck, jobId, percent, materials}`:

1. `Format as NLP Output` — fakes a "complete" parse; **the webhook path bypasses the LLM agent entirely**
2. `Workflow Configuration` (Set) — all rates, truck→Motive ID map, Freetown storage location, 16 cy capacity
3. `Process AI Response` — normalizes, fans out into two branches
4. **Branch A (job context):** Vonigo login → `/data/WorkOrders/` → `Parse Vonigo Job Data` (field IDs 200 / 9271 / 185 / 11215) → `/data/Contacts/` → Google Geocode
5. `Format Volume Reference` → `Build API Request Body` → **Anthropic Haiku** → `Parse Volume Estimate` → `{volumeCY, confidence, confidenceScore, reasoning}`
6. **Branch B (facilities):** Motive `vehicle_locations` → `Filter Facilities By Time` (sheet hours + closed days) → `Calculate Facility Distances` (haversine, detour, per-ton vs minimum, labor, partial-load A/B/C)
7. `Prepare Top 3 for Loop` → Google Distance Matrix per leg → `Aggregate Drive Times` → `Add Wait Times to Routes` (historical lookup)
8. `Calculate Arrival Times and Warnings` — GREEN/YELLOW/RED; **picks cheapest if it arrives within 60 min, else fastest**
9. `Determine Scenario` (18KB, the core) → `Message Builder` → Switch → one of 10 `Format Output - *` → `Respond to Webhook` (JSON, CORS `*`)

**`Determine Scenario` — the 12-branch ordered decision tree:**
facilities closed → 100% full single material → 100% mixed with drop-to-fit → must return to storage → low confidence → go-to-job-first → metal/donations drop → multi-truck → both-recyclables (dual-drop ordering) → partial-load A/B/C → insufficient space.

**Where the LLM is used (bounded, both prompts fully in the file):**
- Slack `Natural Language Parser` agent — **bypassed on the webhook path**, Slack-only
- Anthropic Haiku — estimates the NEXT JOB's volume from its Vonigo description. This is an **input** to the tree (feeds `requiredSpaceCY`, and `confidenceScore < 50` short-circuits to LOW_CONFIDENCE), never the routing decision.

**Constants embedded in code:** mattress 0.5 cy · TV 0.3 · tire 0.2 · donations assumed **70% accepted** · `bufferMultiplier = confidence >= 80 ? 1.0 : 1.3`.

## 5. Google Sheet schema — **DATA NOW CAPTURED 2026-07-20**

> **✅ The data is in the repo.** `docs/route-optimizer-data/` holds `TS_Costs.csv` (29 facilities),
> `Wait_Times_Lookup.csv` (137 rows), `Volumes.csv` (65 rows), plus `TS_Costs_variant_hours.csv`
> (see the conflict in §5.1). Read directly from the live sheet via the Drive connector — the
> connector must authenticate as **charles.dennis@junkluggers.com**, which owns this sheet
> (`1zixJGkTK8DnHfdezpgXDLZ1UuxhFK4fVjTtP2e-_FMg`), NOT tpass2008.
>
> **Schema corrections vs the inferred version below:** `Volumes` has a **fourth column,
> `Category`** (Furniture, etc.) that the n8n analysis missed. `TS_Costs` has all 15 expected
> columns but in a different order. `Wait_Times_Lookup` matched exactly.

### 5.1 ⚠ OPEN DECISION — two conflicting TS_Costs tabs

The spreadsheet contains **two 29-row TS_Costs copies with different operating hours**, and they
disagree materially:

| | `TS_Costs.csv` | `TS_Costs_variant_hours.csv` |
|---|---|---|
| `DefaultWait` | populated 29/29 | absent |
| `Closed` | blank 28/29 | fully populated |
| Borne `Weekdays`/`Saturday` | `7-16` / `7-16` / blank | `9-15` / `7-12` / `"Tuesday, Sunday"` |

The n8n workflow's own examples (`"9-15"`, `"Tuesday, Sunday"`) match the **variant**, which
suggests the hours in `TS_Costs.csv` are stale — but it is the copy carrying `DefaultWait`.
**Neither file is complete on its own.** An import needs an Owner decision on which hours are
authoritative, then a merge. This matters operationally: these fields drive the open/closed
filter, so wrong hours mean routing a truck to a shut facility.

### 5.2 Other data-quality findings

- **Referential break:** `Bob's Tire - Transfer` appears in `Wait_Times_Lookup` but `TS_Costs`
  only has `Bob's Tire - Recycling`. The lookup is a STRING join on facility name, so this row
  silently misses. The other 8 stations resolve. A relational import with a real FK would have
  caught this at write time — an argument for the migration.
- **Wait-time coverage is partial:** only **9 of 29** facilities have any history; `Day` values
  are 2–7 only (**no Sunday**); `Hour` spans 7–15. Any consumer must fall back to `DefaultWait`
  rather than assume a hit.
- `MinRate` blank on 23/29 — consistent, all have `Minimum? = N`. 1 facility `Status = Closed`.
  7 facilities carry a **negative** `PerTonRate` (= revenue, as designed).
- Numeric columns parse clean; no duplicate keys; no blanks in `Volumes`.
- **Facility mix:** Transfer 11 · Recycling: Metal 7 · Donations 6 · Recycling: Cardboard 3 ·
  Recycling: Tires 1 · Recycling: Electronics 1. **`MotiveID` populated 29/29.**

### 5.3 Eleven OTHER tabs in the same spreadsheet

The n8n workflow read three tabs; the spreadsheet has **fourteen**. Relevant to the
"fold spreadsheets into CrewLogic" goal:

- **Term / Default_Volume_CY / Multiplier / Confidence / Notes (63 rows)** — a **fuzzy-term
  volume fallback** table ("misc items", "pallets" PER_ITEM). Almost certainly part of the
  volume-estimation path and worth migrating alongside `Volumes`. Not referenced by the three
  tabs the workflow reads — so it is either consumed elsewhere or by a second automation.
- **Motive geofence dwell events (117 rows)** — Truck / Entity / Start / End / Duration / Cost /
  Pounds. **This is the raw source behind `Wait_Times_Lookup`.** CrewLogic now captures the same
  class of data natively in `geofence_alerts` (with `duration` since v5.50.41), so wait times
  could be derived in-product rather than maintained by hand — that is FW-13.
- **Motive recycler-visit log (185 rows)** — raw scale tickets, plus a month pivot (5 rows)
- Weekday×Hour and Hour avg-minute pivots (54 / 11 / 110 rows) — derived views of the dwell data
- **Estimates-table export (18 rows, full CrewLogic estimate schema)** — a snapshot, likely
  contains customer data; NOT extracted to the repo for that reason
- `Area` picklist (16 rows: First Floor, Basement, Attic…) — overlaps the `item_location`
  options seeded in migration 0052

### 5.4 Original inferred schema (retained for reference)

**`TS_Costs`** — the facility master. `TS Name` · `Address` · `Type` (Transfer / Recycling: Metal / Donations / Recycling: Cardboard|Tires|Electronics|Clothing) · `Status` · `Latitude` · `Longitude` · `PerTonRate` (**negative = revenue**) · `Minimum?` · `MinRate` · `DefaultWait` · `Weekdays` (e.g. `"9-15"`) · `Saturday` · `Closed` (e.g. `"Tuesday, Sunday"`) · `Holidays` · **`MotiveID`** (the join key used for route legs, and the facility primary key).

**`Wait_Times_Lookup`** — `Station` (must match `TS Name` exactly) · `Day` (1–7, **Sunday = 1**) · `Hour` · `Avg_Minutes`.

**`Volumes`** — `Item_Name` · `Volume_CY` · `Aliases`.

**Overlap with what CrewLogic already has:** `facilities` / `facility_hours` / `franchise_holidays` (migration 0023) plus the disposal/recycling/donation wait times in cost settings cover much of `TS_Costs`. A port should map into those tables rather than recreate the sheet. `Wait_Times_Lookup` (historical wait by day+hour) and `Volumes` have **no** CrewLogic equivalent yet.

## 6. Traps for a native port

Found during analysis. Each would produce silently wrong output:

1. **`Parse Volume Estimate` has no outgoing edge** yet is read by name downstream. A naive port that follows the connection graph silently gets the `{volumeCY: 0}` fallback and picks the wrong scenario.
2. **`Filter and Calculate Distances Code` (19.6KB) is near-dead** — recomputed downstream. Do not port it. Its holiday functions are never called (`// TODO`).
3. **Two inconsistent drive-time models.** Options are *chosen* using `haversineMiles × 2`, but *displayed* using real Distance Matrix times. Pick one deliberately; do not carry the inconsistency across.
4. **Timezone is hardcoded Eastern**, using the double-shift `toLocaleString` idiom, and arrival-vs-scheduled compares minutes-of-day while **ignoring the date**. This is exactly the bug class removed from CrewLogic on 2026-07-19 (migrations 0050/0051 + `_shared/tz.ts`). **A port MUST use `_shared/tz.ts` and must not reintroduce this.**
5. **`MotiveID` is the facility primary key** — an odd coupling of a telematics id to a facility record. A native model should key on the `facilities` row and store `MotiveID` as an attribute.
6. **Single-tenant constants throughout** (#90's storage yard, truck ids, rates). Multi-tenant requires all of these to become per-franchise config — which is FW-12.

## 7. Rationale that exists nowhere and should be captured from Owner

These magic numbers drive real money decisions and have no recorded justification:
- **70% donation acceptance** assumption
- **2 min/mile** drive-time estimate
- **30-minute** cost-vs-time trade-off threshold (and the separate 60-min arrival rule in §4 step 8)
- a deferred **$190/ton** rate

## 8. Rebuild sizing (if you go that way)

Roughly ~1,500 lines of ordinary JS with no n8n-specific magic beyond named-node lookups. Natural shape: one `crewlogic-route` edge function reusing the existing `crewlogic-route-disposal` primitives (facility ranking, hours/holiday filtering, Distance Matrix legs) and adding the multi-material recombination tree.

**Sequence:** export sheet data → model `Wait_Times_Lookup` + `Volumes` as tables → port `Determine Scenario` verbatim (it is the value) → replace the Haiku volume estimate with the existing CrewLogic photo/volume AI, which is better at exactly this → wire to the existing facilities tables.

**Not scheduled.** Owner has consistently placed Route Optimizer at roadmap/Enterprise, not launch Pro. This document exists so the option stays open, not because the work is queued.

## 9. Related

- `docs/plan-route-optimizer-r1.md` / `-r1-schema.md` — the R1 disposal-recommender spec that SHIPPED as `crewlogic-route-disposal`
- Hub FW-42 (retire last n8n dependency) · FW-12 (multi-tenant re-architecture) · FW-11 (round-2 ideas) · FW-13 (per-facility wait times — `Wait_Times_Lookup` is the data model for this)
