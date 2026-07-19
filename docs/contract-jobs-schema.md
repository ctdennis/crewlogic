# Contract — Native Jobs Schema + `crewlogic-jobs` API

**Status:** DRAFT for Owner approval · 2026-07-19 · **no schema, no migrations, no code until approved**
**Gate:** contract → schema approval → migrations PR → code PR → smoke → deploy. This is gate 1.
**Author:** Claude (master), Sr. Architect hat
**Inputs:** `plan-native-scheduling.md` (lifecycle, intake, crew decisions), `plan-integration-framework.md` (canonical-first, ownership, `external_refs`), Owner decisions 2026-07-18

---

## 1. Scope

**In:** the canonical job entity, its appointments, crew assignment, reference data, provider mapping, and the `crewlogic-jobs` API.

**Out (each gets its own contract):** invoicing, payments, online booking/availability, labor scheduling, the dispatch-board UI mapping layer, Vonigo/ServiceTitan adapters. This contract defines *where those attach* (§8) without designing them.

**Why now:** `jobs` is the keystone. Scheduling, invoicing, payments and every CRM adapter hang off its grain and time model. Those two choices are expensive to change later and free to change now.

---

## 2. Design decisions (rationale before tables)

### D1 — Job and Appointment are separate tables

Both CRMs split, and for the same real reason: **one engagement can need multiple visits.**

- Vonigo: Job (`jobID`) → WorkOrders. "Copy to another day" makes several WorkOrders sharing one `jobID`.
- ServiceTitan: Job → Appointments. **Their Job carries no time at all**; `start`/`end` live on the Appointment.

This is not theoretical. The 2026-06-29 prod incident — cancelling one appointment cancelled the entire Vonigo job and every appointment on it — happened because the code treated job and appointment as one thing. A flat `jobs` table with a date column would reproduce that class of bug natively and would have no honest mapping to either CRM.

**Our canonical Job ↔ their Job. Our Appointment ↔ their Appointment / Vonigo WorkOrder.** Most native jobs will have exactly one appointment; the table still exists so the second one is not a migration.

*Alternative considered:* single flat table with `scheduled_date`, appointments added later. Rejected — the grain is the one thing a later migration cannot cheaply fix, and both target CRMs already prove the split is real.

### D2 — Store local wall-clock, derive the instant **(refines framework §2)**

Appointments are agreed in local wall-clock: *"Tuesday at 9am."* If a DST boundary falls between booking and service, 9am must stay 9am. Storing a UTC instant makes that silently shift by an hour.

```
scheduled_date   date     -- franchise-local calendar day
start_minutes    int NULL -- minutes from franchise-local midnight (540 = 9:00am); NULL = day-level, unscheduled time
duration_minutes int NULL -- NULL = use job-type default
```

The UTC instant is **derived on read** from `scheduled_date + start_minutes` and the franchise's IANA zone. This is exactly the data `_shared/tz.ts` already resolves (migrations 0050/0051 gave every franchise an explicit `officeTimezone`).

It also converts cleanly both ways:
- **Vonigo** wants naive-local (clock face as UTC) → direct, no conversion
- **ServiceTitan** wants a true UTC instant → derive via the franchise zone
- **Day-level v1** (Q-A) → `start_minutes IS NULL`, no fake midnight sentinel

*This supersedes framework §2's "store an instant (UTC)" phrasing.* The zone is still required — it moved from storage to derivation.

### D3 — `status` is work lifecycle only; money state is derived

ServiceTitan taught this the hard way: their invoice has **six independent status dimensions**, and paid/unpaid must be derived from `balance` vs `total`. Vonigo has the same shape — status (181) *and* label (201), which is why the "done" rule needed both.

So `jobs.status` tracks **work**, and payment state is derived from the (future) payments table. `paid` is deliberately **not** a job status.

```
booked → estimating → won → scheduled → completed
                       └──→ lost
cancelled  (terminal, from any active state)
```

*Departure from `plan-native-scheduling.md` §4*, which listed `paid` as a lifecycle state. Conflating them means a refund or partial payment has to mutate the work status, and reporting can never distinguish "work done, awaiting payment" from "work done, paid."

### D4 — Reference data is relational, per Owner's standing preference (Q-H)

Marketing source, dwelling type, parking, item locations, cancel reasons are **tenant-configurable rows**, not enums or JSON blobs. Marketing source especially — attribution reporting is the whole point of capturing it.

This also maps to how CRMs work: ServiceTitan's `businessUnitId` / `jobTypeId` / `campaignId` / `priority` and `tagTypeIds` are all **tenant-configured integer references**, not free text. A relational model on our side has somewhere to sync those into.

### D5 — Provider identity lives in `external_refs`, never on `jobs`

No `vonigo_job_id` / `servicetitan_job_id` columns. Adding a CRM adds **rows, not columns** (framework §6.1).

### D6 — `origin` is captured from day one

`manual | appointment_center | online | import`. Online booking is P3, but the column ships now so P3 is not a migration — and attribution reporting needs it immediately.

---

## 3. Schema

### 3.1 `jobs`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | pk, `gen_random_uuid()` |
| `franchise_id` | uuid | no | FK `franchises(id)` — **tenancy boundary, every query scopes on it** |
| `job_number` | text | no | human-facing, unique per franchise (see §3.7) |
| `customer_id` | uuid | yes | FK `customers(id)`. Nullable: a job can be booked before the customer record is finalized |
| `service_address` | text | no | denormalized at booking — the address the crew drives to |
| `service_city` | text | yes | |
| `service_state` | text | yes | |
| `service_zip` | text | yes | |
| `service_lat` | numeric(9,6) | yes | populated by the existing Google-first geocoder |
| `service_lng` | numeric(9,6) | yes | |
| `status` | text | no | D3 enum, CHECK-constrained, default `booked` |
| `origin` | text | no | D6 enum, CHECK-constrained, default `manual` |
| `description` | text | yes | free text — what the job is |
| `items_description` | text | yes | what's being removed |
| `notes_internal` | text | yes | **never customer-facing** (mirrors Vonigo field 200 discipline) |
| `dwelling_type_id` | uuid | yes | FK `job_pick_options(id)` |
| `parking_type_id` | uuid | yes | FK `job_pick_options(id)` |
| `marketing_source_id` | uuid | yes | FK `marketing_sources(id)` |
| `estimate_id` | **uuid** | yes | FK `estimates(id)` — the estimate performed *against* this job. ⚠️ **Corrected 2026-07-19 after schema check:** `estimates.id` is uuid; `estimates.estimate_id` is a separate nullable **bigint** (the app-facing number, e.g. `1781003688449`). The FK targets the uuid PK. Note also that `estimates.job_id` already exists as **text** holding the *Vonigo* job id — do not confuse it with this canonical job; if a reverse pointer is ever needed on `estimates`, name it `native_job_id` |
| `estimate_mode` | text | yes | `full \| quick` (Q-F: reporting on who estimated how) |
| `lost_reason_id` | uuid | yes | FK `job_pick_options(id)`, required when `status='lost'` |
| `cancel_reason_id` | uuid | yes | FK `job_pick_options(id)`, required when `status='cancelled'` |
| `cancel_memo` | text | yes | ServiceTitan requires `reasonId` **+** `memo` on cancel — capture both |
| `created_by` | uuid | yes | FK `profiles(id)` |
| `created_at` | timestamptz | no | `now()` |
| `updated_at` | timestamptz | no | `now()`, trigger-maintained |

**Item locations** (`basement`, `2nd floor`, `garage`…) are many-per-job → `job_item_locations` join table (§3.6), not `text[]`. Consistent with D4 and reportable.

### 3.2 `job_appointments`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | pk |
| `job_id` | uuid | no | FK `jobs(id)` **on delete cascade** |
| `franchise_id` | uuid | no | denormalized for RLS + index efficiency |
| `scheduled_date` | date | no | franchise-local calendar day (D2) |
| `start_minutes` | int | yes | minutes from franchise-local midnight; NULL = day-level |
| `duration_minutes` | int | yes | NULL = job-type default |
| `sequence` | int | no | order within the day/route, default 0 |
| `route_id` | uuid | yes | FK `routes(id)` — **native/Vonigo only; ServiceTitan has no route entity** |
| `status` | text | no | `scheduled \| dispatched \| working \| done \| cancelled`, default `scheduled` |
| `created_at` / `updated_at` | timestamptz | no | |

**CHECK:** `start_minutes` between 0 and 1439; `duration_minutes > 0`.

### 3.3 `job_crew`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | pk |
| `appointment_id` | uuid | no | FK `job_appointments(id)` on delete cascade — **crew attaches to the visit, not the job** (matches ServiceTitan Assignments and reality: different visits, different crews) |
| `profile_id` | uuid | no | FK `profiles(id)` — the crew member's own login (Q-C) |
| `role` | text | yes | `lead \| helper` |
| `unique(appointment_id, profile_id)` | | | |

### 3.4 `external_refs`

| Column | Type | Null | Notes |
|---|---|---|---|
| `entity_type` | text | no | `job \| appointment \| customer \| invoice \| payment` |
| `crewlogic_id` | uuid | no | our id |
| `provider` | text | no | `vonigo \| servicetitan \| …` |
| `external_id` | text | no | **text** — never assume numeric |
| `external_version` | text | yes | etag/rowversion. **NULL for ServiceTitan** — they have none |
| `last_synced_at` | timestamptz | yes | |
| `unique(entity_type, provider, external_id)` | | | |
| index on `(entity_type, crewlogic_id)` | | | |

### 3.5 `routes`

Native routes (`name`, `short_code`, `color`, `is_active`, `franchise_id`). Vonigo has routes; ServiceTitan does not — adapters that lack the concept leave `route_id` NULL. Not a blocker for v1 native, but the column ships now because the dispatch board is route-laned.

### 3.6 Reference tables (D4)

- `marketing_sources(id, franchise_id, name, is_active, sort_order)` — "how did you hear about us"
- `job_pick_options(id, franchise_id, category, name, is_active, sort_order)` where `category ∈ dwelling_type | parking | item_location | lost_reason | cancel_reason` — one generic table rather than five near-identical ones
- `job_item_locations(job_id, option_id)` — join

### 3.7 `job_number`

Human-facing identifier crews and customers say out loud. Per-franchise sequence, `unique(franchise_id, job_number)`. Format proposed: zero-padded integer from a per-franchise counter. **Not** the UUID, **not** globally sequential (leaks volume across tenants).

### 3.8 Indexes

- `jobs(franchise_id, status)`
- `jobs(franchise_id, created_at desc)`
- `job_appointments(franchise_id, scheduled_date)` ← **the board query**
- `job_appointments(job_id)`
- `job_crew(profile_id)` ← crew's "my jobs" view
- `external_refs(entity_type, crewlogic_id)`

### 3.9 RLS

Every table franchise-scoped, following the existing `current_franchise_id()` pattern.

- **Owner / office roles:** full access within their franchise.
- **Crew role:** SELECT scoped by `profiles.visibility_scope` (Q-J, already decided) — `all` sees the franchise's appointments; `own_route` sees only appointments they are assigned to via `job_crew`. UPDATE limited to the transitions their role permits (status → working/done, and payment once that exists).
- **Fail closed:** a NULL/unresolvable `franchise_id` returns zero rows, never all rows. (The 2026-07-07 Live Alerts hardening is the precedent — a client-side check bypassed when `franchiseInternalID` was falsy.)

---

## 4. `crewlogic-jobs` API

`POST /functions/v1/crewlogic-jobs`, `{ action, franchiseID, ... }`, mirroring the existing edge-function convention. JWT-verified (this is customer data — **not** `--no-verify-jwt`).

| Action | Purpose | Required |
|---|---|---|
| `list` | board/list query | `dateFrom`, `dateTo`; optional `status[]`, `routeId`, `crewId` |
| `get` | one job + appointments + crew | `jobId` |
| `create` | book a job (+ first appointment) | `serviceAddress`, `origin`; appointment optional (a job can exist unscheduled) |
| `update` | edit job fields | `jobId` + changed fields only |
| `addAppointment` | second visit | `jobId`, `scheduledDate` |
| `reschedule` | move an appointment | `appointmentId`, `scheduledDate`, `startMinutes?` |
| `setDuration` | resize | `appointmentId`, `durationMinutes` |
| `assignCrew` | set crew for a visit | `appointmentId`, `profileIds[]` |
| `transition` | lifecycle change | `jobId`, `toStatus`, + `reasonId`/`memo` when required |
| `cancel` | cancel job or one appointment | `jobId` **or** `appointmentId`, `reasonId`, `memo` |

**`cancel` takes either id deliberately.** Cancelling one appointment must never cancel the job — that is the 2026-06-29 Vonigo incident encoded as an API shape.

### 4.1 Canonical job JSON (response)

```jsonc
{
  "id": "uuid",
  "jobNumber": "1042",
  "status": "scheduled",
  "origin": "manual",
  "customer": { "id": "uuid", "name": "...", "phone": "...", "email": "..." },
  "serviceAddress": { "line1": "...", "city": "...", "state": "MA", "zip": "02347",
                      "lat": 41.86, "lng": -70.92 },
  "description": "...", "itemsDescription": "...",
  "itemLocations": ["Basement", "Garage"],
  "dwellingType": "Home", "parking": "Driveway", "marketingSource": "Google",
  "estimateId": 1781003688449, "estimateMode": "full",
  "appointments": [{
    "id": "uuid",
    "scheduledDate": "2026-07-21",
    "startMinutes": 540,
    "durationMinutes": 120,
    "startLocal": "2026-07-21T09:00:00",      // convenience, franchise-local
    "startUtc": "2026-07-21T13:00:00Z",       // DERIVED via franchise tz — adapters use this
    "timezone": "America/New_York",           // always returned; never make the client guess
    "status": "scheduled",
    "route": { "id": "uuid", "name": "Route 3", "shortCode": "MA3ALL" },
    "crew": [{ "profileId": "uuid", "name": "...", "role": "lead" }]
  }],
  "externalRefs": [{ "provider": "vonigo", "externalId": "861720" }]
}
```

Both `startLocal` and `startUtc` are returned, with `timezone` alongside. Clients never do zone math; adapters take the representation they need.

### 4.2 Errors

`{ success: false, code, message }` with stable codes (`job_not_found`, `invalid_transition`, `reason_required`, `franchise_scope_denied`). Full detail logged server-side; no stack traces, SQL, or provider payloads to the client.

---

## 5. Lifecycle transition rules

| From | To | Guard |
|---|---|---|
| `booked` | `estimating` | — |
| `estimating` | `won` | an estimate exists (`estimate_id` set) |
| `estimating` | `lost` | `lost_reason_id` required |
| `won` | `scheduled` | ≥1 appointment exists |
| `scheduled` | `completed` | all appointments `done` or `cancelled` |
| any active | `cancelled` | `cancel_reason_id` + `cancel_memo` required |

Invalid transitions return `invalid_transition` — enforced server-side, not just in UI.

---

## 6. Provider mapping (proof the canonical model holds)

| Canonical | Native | Vonigo | ServiceTitan |
|---|---|---|---|
| `jobs` | table | Job (`jobID`) | Job |
| `job_appointments` | table | WorkOrder (`woID`) | Appointment |
| `scheduled_date` + `start_minutes` | direct | naive-Eastern epoch + field 9082 | derive UTC `start` |
| `duration_minutes` | direct | field 186 | **derived** `end − start` |
| `route_id` | `routes` | route relation | **none** — leave NULL |
| `status` | D3 enum | status 181 + label 201 | Job status enum |
| `marketing_source_id` | `marketing_sources` | — | `campaignId` (required on create) |
| — | — | — | `businessUnitId`, `jobTypeId`, `priority` **(required, no canonical equivalent)** |

**The last row is the honest gap.** ServiceTitan job *creation* needs tenant-configured values we have no concept of. Two options: sync them as reference data and store per-franchise defaults, or run ServiceTitan **read-only** (framework Q-2) and never create jobs there. Read-only removes the entire problem — this table is the concrete argument for it.

---

## 7. Migrations (after approval)

1. `0052_reference_tables.sql` — `marketing_sources`, `job_pick_options`, `routes` + seed defaults
2. `0053_jobs.sql` — `jobs`, `job_appointments`, `job_crew`, `job_item_locations`, indexes
3. `0054_external_refs.sql` — provider mapping
4. `0055_jobs_rls.sql` — policies (separate so they can be reviewed on their own)

Dev-first, verified read-back, then prod — same discipline as 0050/0051.

## 8. Where future contracts attach

- **Invoices:** `invoices.job_id → jobs(id)`. Nothing in this contract presumes the shape.
- **Payments:** `payments.job_id → jobs(id)` — payment attaches to the **job**, never the estimate (Owner, 2026-07-18).
- **Online booking:** writes `jobs` with `origin='online'`; needs an availability model this contract does not define.
- **Labor scheduling:** joins `job_crew` (deferred, Q-L).

## 9. Open questions

- **Q-S1. `job_number` format** — plain per-franchise sequence (`1042`), or prefixed (`JL-1042`)? Prefix helps when a franchise runs CrewLogic alongside a CRM with its own numbers.
- **Q-S2. Can a job exist with no appointment?** Proposed **yes** — `booked` before a date is agreed (matches a phone intake where the customer hasn't picked a day). Costs nothing; forbidding it later is easy, allowing it later is a migration.
- **Q-S3. Does `completed` require every appointment `done`?** Proposed yes (§5). Alternative: allow manual completion with appointments still open.
- **Q-S4. Multi-day jobs** — is a 3-day cleanout one job with 3 appointments (proposed) or 3 jobs? Proposed model handles it; confirming it matches how you'd want it reported.
- **Q-S5. Should `service_address` denormalize, or always FK to a customer location?** Proposed denormalize on the job (the crew's destination is a fact about the job, and customers move). ServiceTitan uses a Location entity; that mapping still works.

## 10. Approval

On approval this becomes migrations `0052`–`0055` + `crewlogic-jobs`, dev-first, with a right-sized test script at promote (MEDIUM+ tier — data writes, new screens, multi-touch-point). **No code is written until this document is approved.**
