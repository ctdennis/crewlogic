# Contract — Telematics Visits, Geofence-Keyed Facilities & Recycling Revenue

**Status:** DRAFT for Owner approval · 2026-07-20 · **no schema, no migrations, no code until approved**
**Gate:** contract → schema approval → migrations → code → smoke → deploy. This is gate 1.
**Drivers:** retire **MailParser (~$200/mo)**; key facilities on geofence ID not name; track recycling revenue + outstanding.
**Related:** `docs/plan-integration-framework.md` (canonical-first, external_refs), `docs/contract-jobs-schema.md` (sibling contract), `docs/plan-route-optimizer-port.md` (source data).

---

## 1. What this replaces

**Today:** Motive webhook → **MailParser** (parses the alert emails) → appends a row to a Google Sheet → Owner hand-enters `Amount` / `Pounds` when they collect funds from the recycler → outstanding revenue is read off blank cells.

**Verified 2026-07-20:** CrewLogic **already ingests those same webhooks** into `geofence_alerts` — 1,608 events since the 2026-07-02 prod cutover, 209 distinct geofences. **MailParser has been redundant for ingestion since July 2.** What it never did is the money entry; that was always manual.

So the build is three pieces, only one of which is new:

| Piece | State |
|---|---|
| Ingestion | ✅ live (`crewlogic-motive-webhook`) |
| History, 2025-11-01 → 2026-07-02 | one backfill — **1,826 events confirmed retrievable from Motive** |
| Amount / weight / outstanding | ⬜ **the actual build** |

---

## 2. Design decisions

### D1 — Facility identity is `(provider, provider_geofence_id)`, never a name

Owner, 2026-07-20: Bob's Tire was reclassified Transfer → Recycling; the **name changed, geofence ID `2892241` did not**, and every history row keyed on the old name orphaned.

The data confirms the hazard: the API sheet holds **109 distinct `Entity` names across 108 distinct geofence IDs**, with `A&E` appearing four ways, `Zions Middleboro` two, `Bob's Tire` three.

The ID is **already captured** — `geofence_alerts.geofence_id` (bigint), and `motive_geofences` is keyed `(franchise_id, geofence_id)`. The break is at one line of frontend code, `index.html:9453`, which classifies by **case-insensitive substring match** on names:

```js
if (sn === target || ((target.indexOf(sn) >= 0 || sn.indexOf(target) >= 0) && sn.length >= 4)) return {...}
```

**Fix:** add `provider` + `provider_geofence_id` to `facilities`; replace the substring matcher with an ID lookup. Reclassifying becomes a one-field update.

### D2 — A visit is its own row, separate from the event log

`geofence_alerts` is an **append-only event log** that also carries lifecycle notices (`geofence_created`, `geofence_deleted`) and job arrive/leave rows. Money must not be written into it: an immutable log and a mutable financial record have different lifecycles, and a visit would have to be edited months later.

New `telematics_visits` — one row per **completed dwell**. Motive makes this clean: `/v1/geofences/events` returns **paired `start_time`/`end_time` plus `duration`**, so one API record = one visit. No entry/exit pairing logic.

### D3 — `amount IS NULL` means outstanding. Zero is a real value. **[Q-R3 ANSWERED]**

> **Owner, 2026-07-20:** *"I only enter the amount when I have cash in hand."* So there is **no**
> amount-known-but-unpaid state, and no second field. `amount IS NOT NULL` ⇔ money received.
>
> Owner's current process is a visual check — recycling rows are **coloured green**, and they scan
> for any green row without an amount. **The outstanding list in §5.2 is that check, automated.**

Owner's stated rule: *"outstanding … is essentially anything that I haven't entered an amount for."*

So `amount` is **nullable**, and NULL is the outstanding signal. This is load-bearing because the sheet contains a genuine **`0`** and a genuine **`−80`** — "collected nothing" and "charged me" are real outcomes that must not be confused with "not yet entered". A `numeric DEFAULT 0` would silently mark all history as settled.

No separate `collected` boolean: the sheet's `Collected` column is **0/2002 populated** on the API tab, i.e. abandoned. Deriving it from `amount IS NOT NULL` matches how Owner actually works. *(If "I know the amount but haven't been paid" ever becomes real, that needs a second field — flagged as Q-R3, not built speculatively.)*

### D4 — Backfill from Motive, not from the spreadsheet

Probed live 2026-07-20:

| | Motive API | The sheet |
|---|---|---|
| Nov 2025 available | ✅ **1,826 events** for 11-01 → 07-02 | 2,002 rows |
| Coverage | complete | 47 days missing (11 weekdays) |
| Dedupe key | real `id` (`647781266`) | none — composite, 1 collision |
| Timestamps | **UTC, explicit `Z`** | local, **no zone recorded** |
| Vehicle | `id, number, year, make, model, vin` | `"Truck 1"` text |
| Driver | `start_driver` / `end_driver` | column empty |
| `Direction` | n/a (no event_type) | **column-shifted on 1228/2002 rows** |
| Re-runnable | yes | one-shot |

The spreadsheet's **only** irreplaceable contribution is the **money**: 120 `Amount` and 45 `Pounds` values, hand-typed, on recycling visits.

### D5 — Money fill rate is 83%, not 6%

Correcting an earlier mis-statement: `Amount` is on 120 of **2,002** rows (6%) — but the right denominator is **recycling visits**, of which there are 145. So **120/145 = 83%**, and `Amount` appears on **zero** non-recycling rows. `Pounds` is 45/145 (31%). The tracking is disciplined, not sparse.

### D6 — No payment terms, no aging. Two states only. **[REVISED 2026-07-20]**

An earlier draft added `facilities.payment_terms` to distinguish "overdue" from "merely unpaid".
**Owner rejected the premise:**

> *"I don't really care what is on demand or not… keep it simple, collect money, enter revenue &
> pounds and that closes it out. timing doesn't matter, I'm not looking for DSO or anything like
> an aging report."*

So a visit is in exactly **two** states, and `amount IS NULL` already expresses both:

| State | Meaning |
|---|---|
| `amount IS NULL` | still to collect |
| `amount IS NOT NULL` | collected — **closed** |

No terms, no thresholds, no overdue flag, no aging buckets. `payment_terms` is removed in
**migration 0059**.

Two reasons this is the better call. It was modelled on **one franchise's** arrangements (#90:
Zions accrues, everyone else pays at the visit) — precisely the single-tenant assumption that must
not be baked into a shared schema. And the timing logic bought nothing: without an aging report,
knowing *why* a visit is unpaid changes no behaviour. Owner collects, enters, done.

### D7 — Built for every franchise, not #90

Owner, 2026-07-20: *"we will need to extend this to our other franchisees so need to build one
solution for all recyclers."*

Consequences that shape the build:

- **No franchise's geofence IDs are hardcoded.** #90's eight recycling geofences are *data*, not a
  migration. Linking a facility to its telematics geofence is a **Settings action any franchise
  can perform** (§5.0) — that is the generic mechanism; #90 is just its first user.
- Everything is franchise-scoped and RLS-enforced already.
- No assumption that a franchise uses Motive — `provider` is on both `facilities` and
  `telematics_visits` so Linxup franchises work the same way.
- No assumption that recycling *pays*: a franchise whose facilities all cost money uses the same
  screen, with negative amounts. `amount` is signed (#90's history already contains a `−80`).

---

## 3. Schema

### 3.1 `facilities` — additive columns

| Column | Type | Notes |
|---|---|---|
| `provider` | text | `motive` \| `linxup` |
| `provider_geofence_id` | bigint | the stable key |

*(`payment_terms` was added in 0056 and removed again in 0059 — see D6.)*

`unique (franchise_id, provider, provider_geofence_id) where provider_geofence_id is not null`

*One geofence ↔ one facility.* If a site ever needs two geofences (two entrances), that becomes a link table — deliberately not built now (Q-R4).

### 3.2 `telematics_visits` — new

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | pk |
| `franchise_id` | uuid | no | FK, tenancy boundary |
| `provider` | text | no | `motive` \| `linxup` |
| `provider_event_id` | text | no | Motive `id`. **text**, not bigint — Linxup/future providers may not be numeric |
| `provider_geofence_id` | bigint | yes | null when a provider omits it (Linxup does) |
| `facility_id` | uuid | yes | FK `facilities` — resolved when the geofence maps to a configured facility. **Nullable by design:** most visits are job sites, regions, storage, fuel |
| `geofence_name` | text | yes | display label **as recorded at ingest**; never a key |
| `vehicle_label` | text | yes | `"Truck 3"` |
| `provider_vehicle_id` | text | yes | Motive `vehicle.id` |
| `vehicle_vin` | text | yes | stable across renames |
| `driver_name` | text | yes | from `start_driver`/`end_driver` |
| `started_at` | timestamptz | no | **UTC** |
| `ended_at` | timestamptz | yes | null only if a provider sends an open visit |
| `duration_seconds` | int | yes | provider-supplied; not recomputed |
| **`amount`** | numeric(12,2) | **yes** | **NULL = outstanding.** 0 and negatives are real (D3) |
| **`weight_lbs`** | numeric(12,2) | yes | |
| `settled_at` | timestamptz | yes | when Owner entered the amount |
| `settled_by` | uuid | yes | FK `profiles` |
| `note` | text | yes | |
| `source` | text | no | `webhook` \| `backfill` \| `manual` |
| `raw` | jsonb | yes | full provider payload |
| `created_at` / `updated_at` | timestamptz | no | |

**`unique (franchise_id, provider, provider_event_id)`** — makes both the webhook and the backfill idempotent. Re-running the import is safe.

**Indexes:** `(franchise_id, started_at desc)` · `(franchise_id, facility_id, started_at desc)` · **`(franchise_id, started_at) where amount is null`** ← the outstanding query · `(provider_geofence_id)`

**RLS:** franchise-scoped, fail-closed via `current_franchise_id()`, same pattern as migration 0055.

---

## 4. Backfill

`crewlogic-motive-history` (probe, already on dev) gains an **`import`** action.

- Pages `/v1/geofences/events` over `2025-11-01 → 2026-07-02`, ~1,826 events
- Upserts on `(franchise_id, provider, provider_event_id)` → idempotent, re-runnable
- `source = 'backfill'`
- Resolves `facility_id` via `facilities.provider_geofence_id`; leaves NULL when unmapped
- **Does not touch** rows where `amount IS NOT NULL` — money is never overwritten by a re-import

### 4.1 Joining the spreadsheet money

The 120 `Amount` + 45 `Pounds` values, matched to imported visits on **`vehicle_label` + `provider_geofence_id` + `started_at`**.

⚠ **The sheet's timestamps are franchise-local with no zone; Motive's are UTC.** The conversion is reliable *because* every franchise now carries an explicit `officeTimezone` (migrations 0050/0051) and `_shared/tz.ts` resolves it — this is the first consumer of that work outside dispatch.

**Match tolerance:** ±120s on `started_at` after conversion, since the sheet's times passed through MailParser. Report matched / unmatched counts; **unmatched rows are surfaced for Owner review, never silently dropped** — each one is real money.

---

## 5. UI

### 5.0 Linking a facility to its geofence (Settings) — the generic mechanism

Per D7 this is **the** way any franchise adopts the feature; no franchise's IDs are hardcoded.

- In Settings → facilities, each facility gains a **telematics geofence** picker, populated from
  that franchise's own geofences (`motive_geofences`, already cached per franchise by the webhook).
- Picking one writes `facilities.provider` + `provider_geofence_id`.
- Unlinked facilities simply produce no visits — the feature is inert until linked, never broken.
- Show the geofence's **current name** next to the picker so a rename is visible, and make clear the
  link is by ID: renaming or reclassifying in Motive does **not** break it (D1, and the reason
  Bob's Tire survived Transfer → Recycling).

### 5.1 Recycling revenue entry

Trigger, in Owner's words: *"Once a truck enters a recycler and exits, I know I have something to collect."* That is exactly a completed visit whose facility type is recycling — a query, not new plumbing.

- New screen (mobile-friendly — entry happens away from a desk), listing visits at **recycling** facilities with **`amount IS NULL`**, newest first
- Per row: date, truck, facility, duration → inputs for **amount** and **weight**, one tap to save
- Saving sets `amount`, `weight_lbs`, `settled_at = now()`, `settled_by`
- Entering **0** is explicitly allowed and marks the visit settled (D3)
- Editing an already-settled visit stays possible; `settled_at` updates

### 5.2 Outstanding report

Two numbers, per Owner: what came in, and what is still out there.

- **Collected** — `SUM(amount)` and `SUM(weight_lbs)` over a period, selectable **day / week /
  month / year**, with a per-facility breakdown. Derive $/lb where both exist.
- **Still to collect** — every visit at a recycling facility with `amount IS NULL`, grouped by
  facility, with a count. No dates-outstanding, no overdue styling, no buckets (D6).

Both are plain aggregates over `telematics_visits` — the partial index
`where amount is null` serves the second directly.
- **Settled history:** amount and weight by facility by month, with a $/lb derived where both exist
- Deliberately *not* an AR ledger — no invoices, no aging buckets, no statements

---

## 6. What this does NOT include

Job-site geofences, the Live Alerts rail, the Alerts Report, Linxup ID stability (its receiver notes the event may echo a different id — its own fix), invoicing, and the `facilities`/`TS_Costs` hours merge (open in the port plan).

---

## 7. MailParser retirement checklist

1. Approve this contract
2. Migrations + `telematics_visits` + `facilities` columns
3. Map the **108 geofence IDs** → facilities (Owner confirms; only recycling ones are load-bearing)
4. Run the backfill; verify count against the sheet's 2,002
5. Join the 120 amounts + 45 weights; **review unmatched**
6. Ship entry UI + outstanding report
7. Verify one full week: a real recycler visit appears, is enterable, and lands in the report
8. **Then** cancel MailParser

Steps 1–6 can proceed while MailParser keeps running — no gap, no cutover risk.

---

## 8. Open questions

- **Q-R1.** Backfill from **2025-11-01** (matching the sheet) or further? Motive showed no retention wall; earlier data may exist. *Lean: probe 2025-01-01; import whatever comes back — it's free.*
- **Q-R2.** Do the **47 missing sheet days** matter? Motive fills them, so the import will contain visits the sheet never had. *Lean: import everything; more history is strictly better.*
- **Q-R3. ANSWERED 2026-07-20 — no.** *"I only enter the amount when I have cash in hand."* `amount IS NOT NULL` ⇔ money received. No second field.
- **Q-R7. ANSWERED 2026-07-20 — per-visit `amount` stands; no `settlements` table.** Only **one** facility accrues (Zions Middleboro, `on_demand`); everything else is cash at the visit. Zions already carries **62 per-visit amounts** in the history, so loads are valued individually and Owner records them individually — the lump-sum-with-no-breakdown case that would have forced a settlements table does not arise. Should a second accruing facility ever pay one undifferentiated cheque, revisit then.
- **Q-R4.** Can one facility have **two geofences**? *Lean: no for v1; link table later if it appears.*
- **Q-R5.** Should **non-recycling** visits (transfer stations — a cost, not revenue) also accept amounts? The sheet shows amounts only on recycling, but disposal fees are real money. *Lean: allow it; the schema is identical and the report filters by facility type.*
- **Q-R6.** Weight is only 31% filled. Keep it optional, or prompt for it? *Lean: optional — never block a settlement on a number Owner may not have.*

## 9. Approval

**All blocking questions are answered** (Q-R3, Q-R7). Remaining open items — Q-R1 how far back to
probe, Q-R2 the 47 extra days, Q-R4 two-geofence facilities, Q-R5 transfer-station costs, Q-R6
optional weight — are all **reversible defaults** that do not change the schema; the leans stated
above will be applied unless vetoed.

On approval: migrations `0056`–`0058`, the `import` action on `crewlogic-motive-history`, then UI.
Dev-first with a right-sized test script at promote (**MEDIUM+** — data writes, real money,
multi-touch-point). **No code until this is approved.**
