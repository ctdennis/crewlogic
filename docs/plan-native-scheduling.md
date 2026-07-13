# Plan — Native Scheduling / Jobs

**Status:** DRAFT for Owner review · 2026-07-12 · no code yet
**Author:** Claude (master) · grounded in a read-only codebase map (2026-07-12)
**Related:** `docs/plan-caps-roles-enforcement.md` (tiers/seats), `docs/plan-payments.md`, CLAUDE.md "Time zones & dates", "Dev-promotion test discipline"

---

## 1. The gap this closes

Native Starter → native Pro is today a **hollow upgrade**: nearly every "Pro" surface (dispatch board, Manage Jobs, Job Plan, Route) is hard-gated to Vonigo and reads live from Vonigo WorkOrders. A native franchise (no CRM) that pays for Pro gets almost nothing extra it can actually use. To make the tier ladder real for native customers, native needs its **own scheduling primitive** — a way to represent a scheduled job — plus the screens that read from it.

This is also the **Pro-tier value story for native**: Starter = estimate + price book + customers; **Pro = scheduling, dispatch board, truck map, job plan.**

## 2. Current state (verified 2026-07-12)

**Native franchises already have:** customers (inline on estimates), native price book, estimates (`estimates` table — carries `client_name/address/zip/client_phone`, `status`, `payload`, but **no scheduled date, no crew**), `crew_members` (currently **signs-only**), trucks + telematics (`franchise_trucks`, Vault creds — CRM-independent), `facilities`/`facility_hours`/`franchise_holidays`, `job_geofences`.

**Native franchises have NO:** job/appointment/work-order table. `job_plans` is only a cached AI route-plan output (jobs live inside its `routes` jsonb, sourced from Vonigo) — not a job store.

**Tile gates today (index.html):**

| Tile | Line | Gate | Native today |
|---|---|---|---|
| Truck map (`trucksCard`) | ~7593 | always-on, per-user toggle | **Works now** (telematics resolves via Vault regardless of CRM) |
| Route / disposal (`disposalRouterCard`) | ~7602 / ~7424 | telematics **AND** Vonigo | Blocked (Vonigo half) |
| Manage Jobs (`manageJobsCard`) | ~7611 | Vonigo | Blocked — needs native jobs |
| Dispatch board (`dashboardCard`) | ~7617 | Vonigo **AND** desktop ≥1024 | Blocked — needs native jobs |
| Job Plan (`jobPlanCard`) | ~7627 | Vonigo | Blocked — needs native jobs |

Vonigo-gate expression throughout: `submissionTarget !== 'none' && pricingSource !== 'native'`.
Dispatch/job data source: `crewlogic-todays-workorders` → Vonigo WorkOrders (objectTypeID 19); `crewlogic-job-plan` calls it over HTTP and groups by route.

## 3. Key architectural decision — mirror the WorkOrder shape (source-swap, don't fork the UI)

The dispatch board, Manage Jobs, and Job Plan UIs **already exist** and are proven against the Vonigo WorkOrder JSON shape. Rather than build parallel native screens, build a **native jobs source that returns the same shape** the Vonigo path returns, and route to it by `pricingSource === 'native'` (or a new `jobSource` capability). This is the **exact pattern already in production**: `crewlogic-pricing` mirrors `crewlogic-price-lookup`'s JSON so the estimating engine is unchanged — only the data source swaps.

Payoff: the expensive UI work is mostly **un-gating + source routing**, not net-new screens. (Reuse-not-copy per repo convention.)

## 4. The job is the anchor — intake channels + lifecycle

**Correction to the naive model:** a job does **not** come from an estimate. In the real (Vonigo) flow the **job = an appointment, created FIRST**; the estimate is a *step performed against an existing job*. You cannot even start an estimate until a job exists (today that job is a Vonigo WorkOrder — which is exactly why native has no path to schedule one). Some jobs never have an estimate at all (a repeat customer books a haul directly). **The job is the central entity; the estimate is one optional stage in its lifecycle.**

### Intake channels — how a job (appointment) gets created

| Channel | Who creates | Vonigo parity | Native surface | Phase |
|---|---|---|---|---|
| **Manual placement** | Owner / BDM | Owner drops a job on the schedule | Job-create form on the board/calendar | P1 |
| **Appointment center** | Internal phone agent (on behalf of customer) | Call-center booking | Same create form, agent/booker use | P2 |
| **Online booking** *(Pro)* | Customer (self-service) | Vonigo online booking widget | Public, tokened page → customer self-books from **open availability**; **pricing shown by zip / pricing zone** (native price engine) | P3 / own sub-plan |

The estimate is **not** an intake channel — it happens *against* a job created by one of the above.

### Native booking form (manual intake — ships day one)

Native tenants book their own appointments from day one (owner/BDM/staff). This is a real surface, not a stub, and the **same field set is reused** by the appointment-center agent (P2) and the online self-booking page (Pro, P3) — build the form once:

- **Address lookup** — type-ahead autocomplete, suggestions **ranked by distance from the franchise** (Google Places Autocomplete, location-biased). Reuses the existing Google Maps investment (Street View + Distance Matrix already in use); note the per-domain referrer-lock on the Maps key (add the referrer for any new booking domain).
- **Calendar / route availability** — the booker sees the day's existing jobs + remaining capacity when picking a slot (depth = Q-I).
- **Intake fields tracked on the job:**
  - **Items to take** (list) + **job description** (free text)
  - **How did you hear about us** — franchise-configurable **marketing categories** (attribution → reporting)
  - **Dwelling type** — home / office / retail / warehouse / … (select)
  - **Location of items** — multi-select: first floor / 2nd floor / … / outside / garage / attic / basement
  - **Parking** — driveway / street / parking lot / loading dock / … (select)

### Job lifecycle (state machine)

```
booked ─► estimating ─► won ─► scheduled ─► completed ─► paid
                         └─► lost (close)
reschedule (new date) / cancel — available from any active state
```

- **booked** — appointment created via an intake channel.
- **estimating** — **every job gets an estimate before removal** (not skippable — there is no no-estimate path). Tooling varies by who does it: the **full estimator** (BDM / owner / manager, larger jobs) or the **slimmed crew flow** (volume check / manual truck-fraction, most jobs, done on arrival).
- **won / lost** — estimate outcome; won → scheduled, lost closes the job.
- **scheduled** — the haul is on the calendar (may reuse the appointment slot or a follow-up date).
- **completed → paid** — work done, then **customer payment accepted** (new capability — see §5 payment fields + Q-G).
- **rescheduled / cancelled** — from any active state.

Mirrors the Vonigo status/label semantics already documented (status 160 Open / 161 Booked / 164 Completed / 165 Archived; labels Est Completed-Job / Est Completed-Est.Only / Lost / Est Converted).

**Granularity implication (Q-A):** manual + appointment-center booking work fine **day-level**. **Online self-booking requires time-slots + an availability/capacity model** (the customer picks an open slot) — so it lands last and may deserve its own sub-plan.

## 5. Data model (proposed — validate before building)

One new primitive; reuse everything else.

**`jobs`** (new table — the anchor)
- `id uuid pk`, `tenant_id uuid`, `franchise_id` (match `estimates` FK style)
- `origin text` — intake channel: `manual | appt_center | online` (see §4; estimate is a stage, not an origin)
- **every job is estimated** (no direct-haul path); the *tool depth* varies by role — full estimator (BDM/owner/mgr) vs slimmed crew flow. The estimate record carries `estimate_mode` (`full | quick`) for reporting.
- `customer_name`, `customer_phone`, `address`, `zip`, `lat`, `lng`
- `scheduled_start timestamptz`, `scheduled_end timestamptz`, `duration_min int` — **absolute instants; render in franchise TZ** (see §7)
- `truck_id` → `franchise_trucks`
- `status text` — lifecycle (see §4): `booked | estimating | won | lost | scheduled | en_route | on_site | completed | paid | cancelled`
- **payment:** `payment_status text` (`unpaid | paid | refunded`), `paid_amount numeric`, `tip_amount numeric`, `collected_by` → `crew_members`, `paid_at timestamptz` — customer payment **+ tips** captured at completion (crew are frequently tipped); tips roll up to a **payroll tips-by-period report** (Q-G / Crew)
- `price_total numeric`, `notes text`, `sort_order int` (board ordering)
- **intake (booking-form §4):** `job_description text`, `items_to_take text[]`, `marketing_source_id` → `marketing_sources`, `dwelling_type_id`/`parking_id` → `job_pick_options`, `item_locations text[]` (multi-select of `job_pick_options` labels)
- `created_by`, `created_at`, `updated_at`
- RLS scoped by `tenant_id`/`franchise_id` (match existing tables)

**Reference / config tables (franchise-configurable select lists, seeded with defaults):** `marketing_sources` (how-did-you-hear → attribution reporting, its own table since it's reportable) and a generic `job_pick_options(kind ∈ dwelling | parking | item_location, label, sort_order, active)`. Keeps the dropdowns editable per franchise and the reportable ones relational rather than buried in a blob (Q-H).

**Estimate ↔ job (the arrow, corrected):** the estimate attaches to the job, not the other way around — `estimates.job_id` points to `jobs.id` (native), exactly as it points to a Vonigo WorkOrder ID today. This is the fix for "you can't do an estimate without a job": native estimates currently have **no native job to attach to**, so they can't move past draft. Once native jobs exist, an estimate is created from a `booked` job (status → `estimating`), and the won/lost outcome flips the job's status.

**`job_crew`** (join) — `job_id` → `jobs`, `crew_member_id` → **`crew_members`** (extend its use from signs-only to dispatch; schema already has name/phone/status/auth_user_id — no change needed).

**Reused as-is:** `crew_members`, `franchise_trucks`, `facilities`/`facility_hours` (disposal router), `job_geofences`, `franchise_holidays`.

## 6. Edge functions

- **`crewlogic-jobs`** (new) — CRUD + `listByDay` (returns the **WorkOrder-mirrored shape** for board/plan reuse), `reorder` (board sort), `assignCrew`, `setStatus`. Native auth (session JWT); no Vonigo.
- **Native source adapter** — the `listByDay` output feeds the existing dispatch board / Manage Jobs directly; `crewlogic-job-plan` gains a native branch that reads `crewlogic-jobs` instead of `crewlogic-todays-workorders` (same grouping logic).
- **Disposal router native path** — strip the "next Vonigo job" half; keep telematics + `facilities` (truck → nearest open facility). Mostly un-gating.
- Each new function ships with a `curl` **API smoke check** as it's born (per CLAUDE.md dev-promotion discipline).

## 7. Screens unlocked (native path)

1. **Truck map** — already works; just confirm toggle-on for native+telematics. *(P0, ~free)*
2. **Disposal router** — un-gate for native+telematics, native facility routing. *(P0, small)*
3. **Job create / manual placement** — form on the board/calendar for owner/BDM to create an appointment (job); the same form is the appointment-center agent surface. The estimate is then done *against* the job (status `booked → estimating`). *(P1 manual · P2 appt-center)*
4. **Dispatch board** — un-gate + source-swap to `crewlogic-jobs.listByDay`. *(P2)*
5. **Manage Jobs** — native CRUD via `crewlogic-jobs`. *(P2)*
6. **Job Plan** — native branch in `crewlogic-job-plan`. *(P3)*
7. **Online booking page** — public, tokened; customer self-books from open availability → creates a job. *(P3 / may be its own sub-plan)*

**Mobile dispatch interaction (crews live on phones — decided 2026-07-12).** The schedule needs its own mobile model, not a shrunk-down desktop board:
- **Tap a job → bottom action sheet** — Reschedule (native date/time picker, respects availability) · Reassign route/crew · Cancel. This is the primary "move."
- **Long-press to move between days** — long-press lifts the job, valid target days/routes highlight, **tap the destination** to drop (tap-to-place, no fiddly cross-column drag).
- **Drag handle to reorder within a day** — SortableJS touch mode (already used for truck order + tile drag).
- **Desktop keeps** the two-day side-by-side drag for office/dispatcher (≥1024px).

## 8. Cross-cutting concerns

- **Time zones (CRITICAL).** Scheduling IS the calendar/epoch code CLAUDE.md warns about. Store `timestamptz` (absolute); render via `resolveTimezone(cs)` + `localParts()` (canonical in `crewlogic-route-disposal`). **Never `Date.UTC(...)` for a wall-clock moment**; wall-clock→epoch must be TZ-aware (DST). Multi-tenant across ET/CT/MT/PT/AZ/HI/AK. Lift the TZ helpers to `_shared/` when the second function needs them.
- **Tile un-gating** — introduce a `jobSource` capability (`'vonigo' | 'native' | 'none'`) rather than overloading `pricingSource`; drives which tiles show and which source the board reads. Preserves the existing Vonigo path untouched (regression guard).
- **Crew role (separate class — decided 2026-07-12).** Crew get their own login, **treated separately** from office seats for access + billing. New `role='crew'` (extends the existing owner/estimator/dispatch CHECK). Scoped capabilities:
  - **View the schedule** (Managed Jobs) — owner sets visibility **per crew member** (`profiles.visibility_scope ∈ own_route | all`).
  - **Interact with jobs** — cancel, reschedule, **accept payment + record tips**.
  - **Slimmed on-site estimate** — manual truck-fraction pricing (¼ / ½ / full); **limited AI only: volume check + price lookup** (not the full estimator / AI analyze).
  - **Free, non-seat role, gated to Pro+** (recommended — Q-K); metered AI cost already captured by the franchise usage caps.
- **Test tiers** (per new discipline) — jobs CRUD/board = MEDIUM (data writes, read-backs); anything touching the access gate or Vonigo path = HIGH.

## 9. Phasing

- **P0 — telematics wins (cheap, no schedule primitive):** native truck map confirmed on; disposal router un-gated + native facility routing. Delivers immediate native+telematics value while P1 is built.
- **P1 — native scheduling primitive + lifecycle:** `jobs` + `job_crew` tables, `crewlogic-jobs` edge fn, the **manual placement** form (owner/BDM), and the **estimate-against-job** link (`booked → estimating → won → scheduled`; won transitions the job to scheduled). This is the foundational build.
- **P2 — native dispatch board + Manage Jobs + appointment-center channel:** un-gate + source-swap to the mirrored shape; the manual form doubles as the agent booking surface. Highest-visibility payoff.
- **P3 — native Job Plan + online customer booking:** native branch in `crewlogic-job-plan`; **online self-booking** (public tokened page) which forces the availability/slot model — likely its own sub-plan. Full native route-optimization stays roadmap/Enterprise (today #90-only via n8n).

## 10. Open questions for Owner

- **Q-A. Scheduling granularity for v1** — day-level (assign a job to a day + crew, board reorders within the day, matches the current 2-day board), or time-slot (start/end times, calendar grid)? *Lean: day-level first (matches the existing board) for manual/estimate/appt-center; online self-booking (P3) forces slots + an availability model regardless, so that's where times land.*
- **Q-B. Where's the Starter/Pro line for scheduling?** You've said **online booking is Pro** and **native tenants book their own appointments out of the gate** (manual). So manual scheduling/dispatch is core native ops; online self-booking (+ availability engine + customer payment) is the Pro upsell. *Lean: manual booking/dispatch = Starter+ (native baseline); **online booking = the Pro differentiator**. Confirm exactly where the line sits.*
- **Q-C. Crew access — DECIDED (2026-07-12):** crew = **separate role + own login**, treated separately from office seats. Can view the schedule, interact with jobs (cancel / reschedule / accept payment + tips), do a slimmed on-site estimate, and use **limited AI (volume check + price lookup) only**. Remaining crew sub-decisions: Q-J (visibility scope), Q-K (seat-counting), Q-L (labor scheduling).
- **Q-D. Start P0 (telematics wins) in parallel now,** or sequence strictly P0→P1→P2? *Lean: P0 in parallel — it's independent of the schedule primitive.*
- **Q-E. Online customer booking** — in-scope for this plan (P3) or spun into its own sub-plan (public surface + availability/capacity engine)? Either way `jobs.origin` is designed in now so it slots cleanly. *Lean: its own sub-plan; design the hooks in from day one.*
- **Q-F. Estimates — DECIDED (2026-07-12):** there is **always an estimate** (no direct-haul / no-estimate path). Most jobs use the **slimmed crew flow** (volume check / manual truck-fraction) done on arrival prior to removal; the **full estimator** (BDM / owner / manager) is for larger jobs. Track `estimate_mode` (`full | quick`) on the estimate for reporting.
- **Q-G. Customer payment collection ("complete the job and accept payment")** — is taking the **end-customer's** payment for the haul in-scope, or does v1 stop at `completed` and mark paid manually (payment taken outside the app, as today)? This is a **new capability** distinct from SaaS subscription billing — it'd be Stripe again but collecting on the franchise's behalf (Stripe Connect / destination charges), which is a meaningful build. *Lean: v1 stops at `completed` + manual "mark paid"; real in-app customer payment is its own phase (likely alongside online booking, since both are customer-facing money surfaces).*
- **Q-H. Select-lists relational vs blob** — marketing source / dwelling / parking / item-location: model as franchise-configurable **reference tables** (`marketing_sources` + generic `job_pick_options`) so they're editable and reportable, per your ask-before-blob preference? *Lean: yes — relational; marketing source especially (attribution reporting). Free text (job description) stays a column; `items_to_take`/`item_locations` as `text[]`.*
- **Q-I. Availability depth in v1** — the manual booking form shows the day's existing jobs + remaining capacity (light, booker uses judgment), OR a computed **open-slot availability engine** (auto-offers free slots)? *Lean: light calendar visibility in v1; the computed slot/capacity engine ships with online self-booking (Pro), which is the surface that actually needs it.*
- **Q-J. Crew visibility — DECIDED (2026-07-12):** owner toggles it **per crew member** — some crew see only their own route, others see all routes. Stored on the crew member (`profiles.visibility_scope ∈ own_route | all` for `role='crew'`).
- **Q-K. Crew seats — RECOMMENDATION (pending Owner confirm):** crew = **free, non-seat role, gated to Pro+**. Do NOT count toward the 2/5/∞ caps. Rationale: seats are for office/management; crew's metered AI cost (volume check + price lookup) is already captured by the **franchise usage caps** (Epic D); free unlimited crew maximizes on-platform payment/tip/usage capture; monetize via the **tier** (Starter = office only; Pro+ = unlimited free crew + dispatch). Guard: keep crew capabilities limited so a crew login can't substitute for an office seat; optional soft sanity cap.
- **Q-L. Team/labor scheduling — DECIDED (2026-07-12): DEFERRED.** Its own initiative after native job scheduling ships (days off, shift rotation for partner variety, weekend fairness — the Vonigo gap). Design the `jobs ↔ crew` links now so it connects cleanly later; do not build in this plan.
