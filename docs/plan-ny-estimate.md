# NY Estimate Mode — Vonigo-first, photo-by-photo AI + margin — Plan

**Status:** DRAFT for owner review (2026-08-08, rev 2). No code yet.
**Owner:** driving; NY operation (Kevin) provides NY-unique pricing inputs + a test job number.
**Tracking:** TodoWrite (new task).

> **This is a general "reverse estimate" mode, not NY-only.** NY is the driver, but other franchises
> may want the Vonigo-first flow, so it's flagged per-estimate (not hardcoded to NY) and **gated as a
> feature** (tier = Reverse $69.99, §9b).
>
> **Naming:** the **customer-facing home-screen card is "Estimate Costing"** (owner, 2026-08-08 — "reverse
> estimate" is confusing jargon). Suggested card subtitle: "Cost a Vonigo estimate from photos → margin."
> **"Reverse estimate" stays the internal/technical term only** (the `is_reverse_estimate` flag, this plan, the
> DB) — do not surface it in the UI.

## 1. Goal

NY's estimating runs in the **reverse order** from CrewLogic's: photos are loaded into **Vonigo first**,
and the Vonigo estimate drives the cost. This mode lets NY **pull an existing Vonigo estimate + its photos
into CrewLogic**, run the AI **per photo** (description + volume in cu yd + Vonigo-style truck increments),
let the estimator **mark it up** (adjust volume, add labor / discounts / surcharges / donation credits the AI
missed), then produce a **margin analysis** — revenue from Vonigo's zip price schedule vs. cost from
CrewLogic's cost setup. **Read-only to Vonigo** (no write-back in v1).

Everything here is a capability CrewLogic already has (AI photo→volume, 1/8-truck increments, cost/margin);
the **order of operations and the screen are different**, and the Vonigo-pull is new (photo pull proven 2026-08-08,
memory `vonigo-pull-photos-documents`).

## 1b. Which estimates the picker shows (owner-narrowed 2026-08-08)

**The picker shows only COSTABLE estimates: label 9996 "Estimate Completed (Est. Only)" (yellow-green) that
actually have photos.** This is the stage where the estimate has been performed and photos loaded — the only
thing there's anything to cost.

- **Excluded: purple 9973 "Estimate Only"** — a pre-visit, scheduled-but-not-performed estimate. No quote, no
  photos, nothing to cost (owner: "eliminate the purple estimate; this is only for estimates that actually have
  photos"). Verified: David Michael / Askins (9973) carry `quoteID:""` and 0 photos.
- **Filter by LABEL, not route.** 9996 estimates can sit on a regular route, not just EST (verified: 867798 /
  "Mike" is label 9996 on Route 1 with 26 photos). A route-only filter would miss those — so the edge fn keys off
  `label === 9996` and then requires `photoCount > 0` (photos live on the QUOTE). EST route (3848) is used only to
  prefer the estimate WO when deduping a job's WOs. *(Resolves open item 2.)*

*(Future: 245 "Estimate Completed (Job)" — a converted estimate — could be added if owner wants to cost
already-booked jobs; out of scope for now.)*

## 2. The flow

1. **Pick the estimate** — a **date picker + a jobs/estimates dropdown** for that day; the picker lists only
   costable estimates (label 9996 "Estimate Completed (Est. Only)" **with photos**; purple 9973 excluded). Select one.
2. **Pull from Vonigo** — that estimate's structure (customer, address, **zip**, service items, any existing
   Vonigo volume/price) + **all its photos** (documents → download URLs).
3. **Per-photo AI, grouped by room** — photos are **grouped by room/area**; the AI produces a per-photo
   **description** but a **single de-duplicated volume per group** so multiple angles of the same pile aren't
   double-counted (owner directive — see §5).
4. **Mark up (estimator elements, reused)** — per-photo **volume adjust up/down**; add **labor, discounts,
   surcharges, truck volume, donation credit** the AI didn't catch.
5. **Price (revenue)** — total volume → priced via the **Vonigo price schedule for the job's zip**, honoring the
   Vonigo **increment scheme** and the **minimum** (charge = max(minimum, volume-priced)).
6. **Cost** — from CrewLogic's **Cost tab** setup: disposal, recycling revenue, donation volume discount, travel
   time (to/from jobs + disposal/recycling/donation), total mileage + fuel (+ any **NY-unique** items from Kevin).
7. **Margin** — revenue − cost, per estimate. Understand the job's margin. (No write-back.)

## 3. Reuse vs. new

| Piece | Status |
|---|---|
| Pull Vonigo estimate + **photos** (documents → download URLs → JPEG) | ✅ proven (memory `vonigo-pull-photos-documents`) |
| AI photo → volume (cu yd) | ✅ `crewlogic-ai` — **adapt to per-photo** (today it analyzes all photos into one holistic number) |
| Cu-yd → **truck increments** (1/8, per Vonigo) | ✅ volume-panel eighths logic |
| Vonigo **zip price schedule** + minimum | ✅ `crewlogic-price-lookup` / `crewlogic-pricing` (Vonigo price-book by zip) — **confirm increment + minimum flow through** |
| **Cost** engine (disposal/recycling/donation/travel/mileage/fuel) | ✅ CrewLogic Cost tab (`cost_settings`) + cost-analysis engine |
| Manual markup (labor, discounts, surcharges, truck volume) | ✅ estimator components — **reuse on the new screen** |
| Vonigo-first **ingestion** + per-photo loop + **new screen** + margin roll-up | 🆕 the new work |

## 4. Data we pull from Vonigo (per estimate)

- WorkOrder/Quote: objectID, customer name, **address + zip**, service date, status/label, existing volume/price
  (if the Vonigo estimate already has one), item notes.
- **Photos (on the QUOTE, not the WO):** `POST /data/documents/ {method:"-1", quoteID:<WO's quote relation id>, isCompleteObject:"true"}`
  (or `jobID:<job#>`) → each doc's download URL `…/api/Download/?<GUID>#<name>` → GET the JPEG (GUID self-authenticating).
  **Ignore the filename** for room inference (§5). Store bytes in Supabase `estimate-photos`, or reference the Vonigo URL.
- Job-picker list: `POST /data/WorkOrders/ {franchiseID, dateMode:"3", dateStart/dateEnd, ...}` filtered to
  **estimates, not completed** (exact filter TBD — likely the **Estimate route (EST / 3848)** and/or estimate
  **labels**, excluding status 164/165). *(Open item — confirm which Vonigo field marks "estimate".)*

**Storage (decided):** reuse the `estimates` table + a dedicated **`is_reverse_estimate` boolean** column that
flags a Vonigo-first reverse estimate (**not** NY-specific — any franchise can opt in). Add a `vonigo_ref`
(quote/WO id); the **per-photo AI results** (description, cuyd, eighths, adjusted-cuyd) + room grouping + Vonigo
estimate context live in the `payload` jsonb; `cost_analysis` jsonb holds the margin breakdown. Migration:
`ALTER TABLE estimates ADD COLUMN is_reverse_estimate boolean NOT NULL DEFAULT false;`

## 5. AI grouping + de-duplication (the core of the feature)

This is the piece that makes reverse-estimate different from ordinary photo estimating: the estimator dumps
**N arbitrary, unlabeled photos** and expects **one correct total** — not N photos' worth of double-counted junk.

### 5.1 The two ways photos double-count

1. **Same items, multiple angles (dominant case).** A basement pile shot 6 times is *one* pile — naive per-photo
   summing counts it ~6×. This is the main error source and why per-photo volume must never be summed directly.
2. **One photo, two rooms / an item straddling rooms.** Rarer, but a hallway shot can show items that belong to
   the adjacent room's pile. Handled by the grouping step + estimator override.

Filenames don't help (NYC photos are unnamed — §finding). The only reliable signal is **what's in the image**, so
the AI does the grouping visually.

### 5.2 Approach — TWO passes, with an estimator gate between them

Separating "which photos are the same place" from "how much is there" is what prevents duplication. A single mega-
prompt over 40 images tends to blur the two and mis-count; splitting them lets the model focus, and lets the
estimator fix a bad cluster *before* it poisons the volume.

```
Vonigo photos ─▶ PASS 1: GROUP (1 vision call, all photos)
                   └─▶ clusters = rooms/scenes, each photo assigned to exactly one
                 ─▶ ESTIMATOR REVIEW (drag a photo between rooms, merge/split, rename) ── cheap, optional
                 ─▶ PASS 2: QUANTIFY per room (1 call per cluster, only that room's photos)
                   └─▶ one de-duplicated item inventory + volume per room
                 ─▶ TOTAL = Σ room volumes → round up to 1/8 truck, min 1 cu yd (§6)
```

### 5.3 Pass 1 — Group (cluster photos into rooms)

One call, **all** photos (downscaled thumbnails to control cost — grouping needs scene recognition, not detail).
Prompt intent: *"These photos are from ONE junk-removal estimate. Group them by physical room/area/scene. Multiple
angles of the same room belong to one group. Assign every photo to exactly one group; flag any photo that spans two
rooms."* Returns:
```
{ groups: [ { room_label, photo_indices:[...], confidence, note } ],
  ambiguous: [ { photo_index, reason } ] }   // photos that could belong to >1 room
```

### 5.4 Estimator review of the grouping (the human gate)

Show the clusters on the screen (thumbnails bucketed by room). The estimator can **move a photo to another room,
merge/split groups, rename a room, or drop a photo** (blurry/duplicate/irrelevant). This is the cheap correction
that stops a mis-cluster from becoming a mis-count. Nothing is quantified until the estimator is satisfied (or
accepts the AI grouping as-is).

### 5.5 Pass 2 — Quantify each room (the de-dup happens here)

One call **per room group**, passing **only that room's photos**. The prompt frames them explicitly as multiple
views of ONE space so the model reconciles the same object across angles:

> *"All of these photos show the SAME room from different angles. Build ONE combined inventory of the removable
> items. An item visible in several photos is counted ONCE. Do not add per-photo volumes. Return each item with an
> estimated size, then the total removable volume for the room in cubic yards."*

Returns:
```
{ room_label,
  items: [ { name, qty, est_cuyd, seen_in:[photo_indices] } ],  // the audit trail
  volume_cuyd,          // de-duplicated room total = Σ items
  volume_eighths,       // room total in Vonigo increments (§6)
  confidence, notes }
```
The **`items` inventory is the trust surface** — the estimator sees "sofa, 3 mattresses, ~20 boxes = 4 cu yd" and
can sanity-check *why* the number is what it is, not just accept a black-box figure. `seen_in` shows the model tied
multiple photos to the same object (proof it de-duped).

### 5.6 Totals + editability

- **Total volume = Σ room `volume_cuyd`** (never Σ photos), then billed per §6 (round up to 1/8, min 1 cu yd).
- Editable at every level: adjust a room's volume up/down, add/remove/resize an item in a room's inventory, re-group
  a photo (which re-runs just that room's Pass 2), or override the total. The estimator's edits win over the AI.
- Persisted in `payload`: the grouping map, per-room inventories + volumes, and any estimator overrides (so re-opens
  are deterministic and the AI isn't re-billed).

### 5.7 Cost / performance

- **Pass 1:** 1 call, N downscaled images. **Pass 2:** 1 call per room (873112 → ~11). So ~1 + R calls per estimate,
  R = room count. Metered like other AI calls; show the estimator the call/'cost' the same way the Analysis Engine
  does.
- Re-grouping one photo re-runs only the two affected rooms' Pass 2, not the whole estimate.
- **873112 is the stress test:** 42 photos, and Basement alone is 6 angles of one pile — if the total lands near a
  sane single-home volume (not 42-photos-worth), the de-dup works.

### 5.8 Open questions for build

- **Pass-1 image budget:** 42 thumbnails in one grouping call is fine for Claude; if an estimate ever has 100+, do we
  batch Pass 1? (Defer until we see a real NYC volume.)
- **Auto-run vs. estimator-triggered:** does Pass 1 fire on load, or on an "Analyze photos" button? (Lean: button, so
  the estimator isn't billed for a mis-load.)
- **Model tier (DECIDED 2026-08-08):** **Pass 1 grouping → Haiku** (grouping is not the customer-facing number, and
  the estimator-review gate catches any miscluster, so Haiku is safe here and ~⅔ cheaper). **Pass 2 quantify/volume →
  Sonnet-class or better** (the volume rides the customer's price — identifier-adjacent, never Haiku).

## 6. Pricing (revenue) — Vonigo zip schedule (increments known)

**Increment mechanics (owner-confirmed):**
- **Truck = 16 cu yd. One increment = 1/8 truck = 2 cu yd.**
- **Minimum charge = 1 cu yd** (the first, smallest billable step — a job at/under the minimum bills the minimum).
- Above the minimum, volume bills in **1/8-truck (2 cu yd) steps** — round the total volume **up** to the next 1/8.

So: `billed_volume = max(1 cu yd minimum, roundUpToEighth(total_cuyd))`, then price that billed volume against the
**Vonigo price list for the job's zip** (`crewlogic-price-lookup`/`crewlogic-pricing`). The **dollar amount per
step still comes from the Vonigo zip schedule** — the 16 cu yd / 2 cu yd / 1-cu-yd-min are the quantity mechanics;
the per-step $ is per-zip. *(Confirm the zip price lookup returns the per-increment $ + the minimum $, or read them
from the price-list config.)*

Note: 16 cu yd is the **Vonigo pricing truck** for the increment math here; keep it distinct from CrewLogic's
configured `truckCapacityCY` used elsewhere.

## 7. Cost — CrewLogic Cost tab (+ NY extras)

From `cost_settings` / the cost-analysis engine: disposal cost, recycling revenue, donation volume discount,
travel time (yard↔job↔disposal/recycling/donation), total mileage + fuel. **Plus NY-unique pricing items from
Kevin** (TBD — awaiting his list).

## 8. Margin

`margin = revenue (Vonigo zip price for the volume) − cost (CrewLogic setup)`, shown per estimate with the
component breakdown.

## 9. The screen (new)

Distinct "NY Estimate" screen, reusing the estimator's components:
- **Top:** date picker + estimates dropdown (not-completed / estimates-only) → Load.
- **Photo list:** one card per photo — the image, AI description, editable cu-yd + eighths (adjust up/down).
- **Markup panel:** reused estimator inputs — labor, discounts, surcharges, truck volume, donation credit.
- **Summary:** total volume → Vonigo-zip revenue (with minimum) − CrewLogic cost = **margin**, with breakdown.
- Reuses dark-card / `.btn-surface` styling and the existing estimate/volume/cost components.

## 9b. Feature gating + pricing + cost governor (owner-decided 2026-08-08)

Reverse-estimate mode is a **gated feature**, off by default:
- **Access flag** — off unless the franchise/tenant is entitled (e.g. a `reverse_estimate` capability on
  `tenant_provider_capabilities` or a subscription-tier/entitlement check). The screen + the `is_reverse_estimate`
  flow only appear when entitled. Build behind this flag defaulted off, super-admin-visible for testing.

### Tier ladder (owner, 2026-08-08 — prices live in DB per no-pricing-in-code)
| Tier | Price / location / mo |
|---|---|
| Starter | $29.99 |
| Estimates (regular) | $59.99 |
| **Reverse estimates** | **$69.99** |
| Estimates + Dispatch | $129.99 |
| Dispatch only | $89.99 |

### Cost model (first-order — tune with real numbers)
Assumptions: **20 photos/estimate avg** (owner: reverse is used only for larger jobs), ~6 rooms; **Pass 1 = Haiku,
Pass 2 = Sonnet** (§5.8); Haiku ~$1/$5, Sonnet ~$3/$15 per M tok; Pass-1 thumbs ~500 tok/img, Pass-2 ~1,600 tok/img.

- Pass 1 (Haiku grouping): ~**$0.014** · Pass 2 (Sonnet, 6 rooms): ~**$0.19** → **~$0.22 per reverse estimate** (incl. re-runs).
- Range: ~$0.20 (typical) to ~$0.45 (42-photo heavy).
- **Break-even vs $69.99 flat ≈ ~320 reverse estimates/mo/location.** Below that the flat tier is comfortable; a
  high-volume photo-first shop (NYC) can exceed it — hence the governor.

### Cost governor (owner-approved 2026-08-08) — all values DB-configured, tunable
1. **Included monthly quota + metered overage.** Reverse tier includes **N reverse estimates/mo** (starting
   recommendation **~150**, tunable once real volume shows); beyond that, **metered overage ~$0.35/estimate**
   (covers the ~$0.22 cost + margin). Overage bills rather than blocks, so heavy users pay for what they burn
   instead of the flat tier eating it. At the 150 ceiling AI COGS ≈ 47% of $69.99 — acceptable for a premium AI
   feature; overage keeps every marginal estimate profitable.
2. **Photos-per-estimate cap** — **~50** (873112's 42 is near it). Bounds the worst single estimate; over the cap the
   estimator selects which photos to include.
3. **Hard AI-calls/month ceiling per location** — a runaway safety net independent of tier (guards a mis-config loop).
4. **Governor counters** live in the existing usage metering (`usage_events`), surfaced to the estimator like the
   Analysis Engine's call/cost display, and to super-admin in Settings.

**Follow-up when the commercial side ships (owner, 2026-08-08):**
- **Stripe** — add the **Reverse-estimate $69.99** product/price + the **metered overage** (~$0.35/estimate) usage
  price, and add the two other new lines (**Dispatch-only $89.99**, **Estimates+Dispatch $129.99**). Reconcile
  against the existing Starter/Pro/Enterprise price IDs (memory `payments-processor-and-seats-decision`).
- **Marketing site** (crewlogicai.com) — update pricing/plans copy for the new tier ladder (Starter / Estimates /
  **Reverse estimates** / Est+Dispatch / Dispatch-only) and add a reverse-estimate feature blurb.
- Reflect the reverse tier + governor in `docs/plan-payments.md`.
- Starting quota (150) + overage ($0.35) are placeholders to revisit against real monthly volume ("only time will
  tell" — owner).

## 10. Build phases (proposed)

- **P1 — ingestion: ✅ SHIPPED to dev (2026-08-08).** Edge fn `crewlogic-ny-estimate`:
  - `action:'list'` — costable estimates for a date (label **9996** "Estimate Completed (Est. Only)" **with
    photos**; purple 9973 excluded), deduped by job, each with `photoCount`/`hasPhotos` (checked off the QUOTE).
    Smoked: 2026-08-05 → only 873112 (42 photos); the two photo-less 9996s that day are dropped. 2026-07-18 →
    867798 (26 photos, label 9996 on Route 1 — confirms label-not-route filtering).
  - `action:'load'` — one estimate's full structure (client/contact/address/**zip**/quoteID/label/dateService/
    existingPrice) + all photo download URLs. Smoked: 873112 → 42 photos with filenames + zip 02790.
  - Auth/creds/field patterns mirror `crewlogic-todays-workorders`/`crewlogic-job-lookup`; read-only to Vonigo.
  - Source: `supabase/functions/crewlogic-ny-estimate/index.ts`. (Not a public webhook — JWT-verified app fn.)
- **P2 — AI grouping + de-dup: ✅ SHIPPED to dev (2026-08-08).** Added to `crewlogic-ny-estimate`:
  - `action:'group'` (Haiku) — downloads the estimate's photos, clusters into rooms (visual, filename ignored),
    returns groups + any `ungrouped` indices.
  - `action:'quantify'` (Sonnet) — per room, one de-duplicated item inventory + `volume_cuyd` (counts each item
    once across angles). Bounded concurrency (pool of 4) + per-room error isolation.
  - `action:'analyze'` (chains both; downloads photos once) — returns groups, per-room inventories/volumes, and
    `totalCuyd` / `billedCuyd` (§6 preview: min 1 cy, round up to 2-cy step) / `truckFraction` + token usage.
  - **Smoked on 873112 (42 photos):** 18–19 room groups, de-dup confirmed in the notes; total ≈ **42–48 cu yd
    (~3 truckloads)**, ~**$0.45/run** (Haiku group + Sonnet quantify; 130–140k in / 11–13k out) — matches the
    heavy-case cost model. Un-grouped photos are surfaced + swept into an "Other/Unsorted" bucket so nothing is
    dropped.
  - **Known (resolved by P3 estimator-review):** run-to-run volume variance (~15%) → estimator adjusts; the
    Other/Unsorted bucket can double-count dup angles → estimator reassigns the photo to its room.
  - **Cost lever not yet applied:** Pass-1 sends full images (no downscale — Deno has no native resize). Downscaling
    thumbnails for grouping would cut Pass-1 tokens ~⅔ (§5.7). Deferred (Haiku Pass-1 is already cheap).
- **P3 — screen:** the NY Estimate screen — job picker, photo cards (AI + editable volume), markup panel (reused).
- **P4 — price + cost + margin:** Vonigo zip pricing (increment + minimum) + CrewLogic cost engine → margin roll-up.
- **P5 — NY extras:** fold in Kevin's NY-unique pricing items.

## 11. Open items / blockers

**Test cases (owner-provided 2026-08-08) — probed read-only:**
- **David Michael** (purple/9973) → WO **1007276** (Appt 874460-1), zip **02346**, route EST 3848.
- **Job 873421** (yellow-green/9996; Eric Wordell) → WO **1006041** (Appt 873421-1), address field 184
  "292 Alden Road, FAIRHAVEN, MA 02719" → zip **02719**, route EST 3848, quote 700022.

**What the probe CONFIRMED:**
- ✅ **Filter** = label **9996** "Estimate Completed (Est. Only)" **with photos** (purple 9973 excluded, owner 2026-08-08).
- ✅ **Resolve by jobID** → `POST /data/WorkOrders/ {jobID, isCompleteObject:true}` returns the estimate WO
  (the existing `crewlogic-job-lookup` already does this). Relations carry proper `relationType`
  (client / contact / location1 / **quote** / route / servicetype), **address = field 184** (`fieldValue`);
  parse zip with the state-anchored `/\b[A-Z]{2}\s+(\d{5})\b/`.
- ✅ **Photos hang off the QUOTE object, NOT the WorkOrder** (my first "0 photos" reads were querying the wrong
  parent). Pull with `POST /data/documents/ {method:-1, quoteID:<the WO's quote relation id>}` — or equivalently
  `{method:-1, jobID:<job#>}`, which also returns the quote's docs. `workOrderID`/`clientID`/`locationID` return 0.
  **This corrects §4 ingestion.**
- ✅ **Byte-fetch VERIFIED from the quote (2026-08-08):** GET'd 4 of 873112's quote-699733 download URLs →
  **HTTP 200, real JPEG bytes** (magic `ffd8ffe0`, ~300–450 KB each). Full loop works: list by quoteID → download
  URLs → GET → JPEG. No technical risk on photo ingestion.
- ✅ **Photos ARE on #90 estimates after all** — **16 of 48** label-9996 estimates have photos (my earlier "2 of
  48" was the wrong-parent artifact). So no NY estimate is required to build/test.

**Photo-bearing test case — job 873112 (Prentice, Selden, zip 02790):** **42 photos on quote 699733**. (The
filenames happen to encode 11 rooms — Basement 6, Bedroom_4 6, Kitchen 4, Garage 4, … — but that's a CrewLogic
naming artifact; **for this exercise we ignore the names and let the AI group visually**, since NYC photos won't
be named. It's still a textbook overlap test — e.g. 6 Basement angles must count once.) *Note the flag bug the
owner called out: 873112 was converted to a job (2nd WO 873112-2 on Route 1) but the label stayed 9996 instead of
flipping to 245 — a real Vonigo-side state the filter should tolerate.* Resolves open item 8 (test estimate).

**Future requirement (scope AFTER reverse-estimate):** **NYC has several estimate routes, not one.** CrewLogic
will need to handle multiple estimate routes (route selection / multi-route job picker). Owner flagged as a
separate upcoming item — deal with it next, not in this scope.

**Still open:**
1. **Kevin** — NY-unique pricing-model items. Blocks P4 pricing.

**Resolved this rev (2026-08-08):**
2. ✅ **Estimate filter (narrowed 2026-08-08)** — picker shows only **label 9996 "Estimate Completed (Est. Only)" WITH photos**; purple 9973 eliminated. Filter by label, not route (9996 can sit on a non-EST route, e.g. 867798 on Route 1). See §1b.
3. ✅ **Increments** — truck = 16 cu yd; increment = 1/8 = 2 cu yd; **minimum charge = 1 cu yd**; round total up to the next 1/8. Per-step $ still from the Vonigo zip schedule (§6).
4. ✅ **Overlap** — code for it: AI **visually** clusters photos by room/scene (NOT by filename — that's a CrewLogic-only artifact, NYC photos are unnamed), produces one de-duplicated volume per cluster, estimator re-groups + adjusts (§5).
9. ✅ **Photos live on the QUOTE object** — pull by `quoteID`/`jobID`, not `workOrderID` (§4). Test estimate: **job 873112** (Prentice, 42 photos, zip 02790).
6. ✅ **Gate + pricing** — Reverse tier **$69.99**; Haiku(group)/Sonnet(volume) split; **quota (~150/mo) + metered overage (~$0.35)** governor + 50-photo cap + hard AI ceiling; all DB-configured (§9b). Cost ~$0.22/estimate, break-even ~320/mo.
5. ✅ **Storage** — reuse the `estimates` table + a dedicated **`is_reverse_estimate`** flag column (not NY-specific) (§4).

## 12. Follow-up actions

Tracked as a new TodoWrite task. Next: owner review/redline → get Kevin's inputs + test job → P1 (ingestion).
