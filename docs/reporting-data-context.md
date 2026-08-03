# Analysis Engine — Data-Context Doc (the AI's onboarding manual)

**Status:** Living artifact. v1 — grounded in the actual dev schema profile 2026-08-02.
**Owner of this file:** whoever ships FW-62. Every session that learns a new data quirk appends here.
**Purpose:** This is the curated "data dictionary + quirks" injected into the Analysis Engine's prompt.
It teaches the model the schema **and the gotchas** so it queries correctly. Getting this right is the
single biggest determinant of correct answers (owner-emphasized). It is NOT auto-generated — it encodes
tribal knowledge a naive `SELECT` would get wrong.

> **Hard rules for every query the engine builds (non-negotiable):**
> 1. **Franchise scope is injected server-side** from the caller's session — never trusted to the model.
>    Nearly every table scopes by **`franchise_id uuid`**; a few also carry `tenant_id`.
> 2. **Read-only.** SELECT only. No INSERT/UPDATE/DELETE/DDL.
> 3. **Timezone:** every timestamp column below is **`timestamptz` (UTC)** unless flagged "naive".
>    Resolve the **franchise's own timezone** (Eastern for #90) and convert **before** any
>    day-of-week / hour-of-day filter. "Saturday" = local dow 6 in that TZ. Never assume Eastern for a
>    non-Eastern franchise (the app has `STATE_TZ` / `resolveTimezone` — reuse it).
> 4. **Output is data only** — never echo generated SQL, connection details, or other franchises' rows.

---

## Populated vs. empty (query only what has data)

| Source | #90 rows | Use for |
|---|---|---|
| `geofence_alerts` | 1889 | **Facility dwell / wait times, truck-at-site events** (the only populated dwell source) |
| `jobs` | 324 (197 completed / 127 scheduled) | Job history, completion counts, service addresses |
| `job_appointments` | 363 | Scheduled dates/times, route assignment, durations |
| `facilities` | 9 | Reference list of transfer stations / recycle / donation sites + per-ton rates |
| `facility_hours` | 63 | Facility open/close by day-of-week |
| `route_volume_estimates` | 12 | AI volume predictions vs. actuals per work order |
| `estimates` | 10 | Estimate totals, trucks, status |
| `estimate_charges` | 55 | Estimate line items + truck volume |
| `franchise_trucks` | 3 | Truck roster (Truck 1/2/3, provider) |
| `usage_events` | 21 | AI-call / photo usage metering |
| `telematics_visits` | **0 — EMPTY** | Intended dwell successor; **do not query yet** (nothing writes to it) |
| `job_crew` | **0 — EMPTY** | Crew-per-appointment; unpopulated |
| `customers` | **0 for #90** | Vonigo franchises keep customers in Vonigo (not mirrored); native tenants only |

---

## `geofence_alerts` — FACILITY DWELL (primary; owner's "Raynham wait" question)

Purpose: telematics geofence events for #90's trucks. **This is where facility wait-time lives today.**
Scope: `franchise_id` (+ `tenant_id`). Timestamps: `start_time`, `end_time`, `created_at` (all tz-aware UTC).

**QUIRKS — read carefully, a naive query gets this wrong:**
- **Dwell = `duration` (SECONDS) on `event_type = 'geofence_exit'` rows ONLY.** Exits are 1836 of 1889 rows;
  the exit row already carries the whole visit's duration. **Do NOT pair `geofence_entry`→exit** — entries
  are sparse (only ~10 rows). `end_time` is often NULL on exits; rely on `duration`, not `end_time - start_time`.
- **Filter blips:** `duration < ~120s` = a truck clipping the fence edge, not a real visit — exclude.
- **Cap missed-exits:** `duration > ~7200s` (2h) = a missed exit — exclude or cap.
- **Classify facility by `geofence_name`, NOT `category`.** `category` is NULL on 99.5% of rows (only 9 enriched).
- **`geofence_name` is mixed:** it contains facilities (`"Raynham - Transfer"`, `"Cape Cod Recycling"`,
  `"Goodwill Plymouth"`), **customer jobs** (`"Lightfoot, Denise · #990831"`), and test fences. For a
  facility-wait question, match the facility name (see mapping below), which also excludes job/test fences.
- Other useful columns: `vehicle_number` ("Truck 3"), `wo_id`, `job_id`, `geofence_id`, `raw jsonb`.
- **TZ:** `start_time` is UTC — convert to franchise TZ before a day-of-week ("Saturday") or hour ("3pm") filter.

**Facility + truck conformance — USE THE VIEW `v_geofence_dwell` (migration 0079).** Don't hand-roll the
join. The view resolves both dimension-key mismatches on real columns (no alias tables needed):
- **Facility:** `geofence_alerts.geofence_id = facilities.provider_geofence_id` (exact; covers 1827/1836
  #90 exit rows). `facility_id` is NULL for non-facility geofences (fuel/office/customer/test).
- **Truck:** `geofence_alerts.vehicle_number = franchise_trucks.name` (per franchise). `truck_id` NULL for a
  retired vehicle number.
It emits one row per real dwell (`geofence_exit`, `dwell_seconds`, `start_time` UTC, resolved
`facility_id`/`facility_name`/`facility_type` + `truck_id`/`truck_name`). Facility-dwell measure =
`where facility_id is not null` + your day/hour filter (convert `start_time` to franchise TZ) + hygiene
(`dwell_seconds between 120 and 7200`). Acceptance: Raynham Saturday = 22 visits, avg 21:07, median 16:56.
**Known gap (~0.5%):** 9 null-`geofence_id` rows (early 2026-07-08→10 window, mostly non-facilities) aren't
facility-mapped; none are Saturdays, so the Raynham measure is unaffected. Backfill those geofence_ids later
if exhaustive coverage is ever needed.

## `facilities` — reference list (#90 = 9 sites)

Scope `franchise_id`. Columns: `name`, `address`, `lat`/`lng`, `per_ton_rate`, `minimum_type`/`minimum_value`,
`provider`, `provider_geofence_id`, `settlement_mode`, `is_active`, facility type.
#90 sites: **Raynham, Rochester, Borne, Vinagro** (disposal/transfer, ~$125–$230/ton) · **Zion, Bobs,
A&E Metal** (recycling) · **Habitat - Falmouth, Habitat - Yarmouth** (donation). All active.

## `facility_hours`

No `franchise_id` — scope via `facility_id` → `facilities` (which is franchise-scoped). ~7 rows/facility.
`dow smallint` (day-of-week), `is_closed`, **`open_time`/`close_time` = `time` (naive LOCAL wall clock)** —
they are the facility's posted hours in its own local time, not UTC. Don't tz-convert these.

---

## `jobs` — job history (#90 = 324)

Scope `franchise_id`. `created_at`/`updated_at` tz-aware. Key cols: `status` (completed 197 / scheduled 127),
`service_address`/`city`/`state`/`zip`/`lat`/`lng`, `items_description`, `estimate_id`, `estimate_mode`,
`source_external_id` (= Vonigo job_number), several `*_reason_id`/`*_type_id` FKs.
**QUIRK — freshness:** `origin='import'` — a **one-time Vonigo backfill** (all rows created 2026-07-23),
**not live-synced.** Historical/aggregate questions are fine; **very recent jobs may be missing** and need live
Vonigo. State the snapshot date when answering "recent" questions, or route them to the live board.

## `job_appointments` — scheduled slots (#90 = 363)

Scope `franchise_id`; `job_id`→jobs, `route_id`. **QUIRKS (naive time fields):**
- **`scheduled_date` = `date` (naive)** — the local service date; do not tz-convert.
- **`start_minutes` / `duration_minutes` = MINUTES FROM LOCAL MIDNIGHT** (480 = 8:00 AM, 120 = 2h). Same
  convention as the schedule board. Convert to a clock time in the franchise TZ for display.
- `status` (scheduled, +2 others), `source_external_id` (Vonigo number). Range 2026-06-08 → 2026-09-04.

## `route_volume_estimates` — AI volume predictions (#90 = 12)

Scope `franchise_id`. Per work order: `service_date` (date), `wo_id`, `low_cuyd`/`high_cuyd`, `confidence`,
`model`, `actual_cuyd` (NULL = not yet reconciled), `eo_converted`, `estimated_at`/`actual_set_at` (tz-aware).

## `estimates` (#90 = 10) & `estimate_charges` (#90 = 55)

Scope `franchise_id` (estimates also `tenant_id`). **QUIRKS:**
- **`estimate_id` = `bigint` MILLISECOND-EPOCH creation id** (e.g. 1783109869430), NOT a UUID. Same key on
  `estimate_charges.estimate_id`.
- **Soft-delete:** `estimates.deleted_at` + `status_before_delete` — **exclude `deleted_at IS NOT NULL`** unless
  explicitly asked for deleted ones.
- estimates: `status`, `client_name`, `total_price`, `total_trucks`, `vonigo_quote_id`, `job_id`, `payload jsonb`,
  `cost_analysis jsonb`, `split_pricing`. charges: `type`/`area`/`room`/`name`, `qty`, `unit_price`, `truck_volume`.

## `franchise_trucks` (#90 = 3) & `telematics_credentials`

`franchise_trucks`: Truck 1/2/3, `provider` (motive for #90), `truck_key`='vin:<VIN>', `active`. Scope `franchise_id`.
`telematics_credentials`: `provider`, `secret_name` (Vault ref — no secret value in-table), `status`,
`last_validated_at`, `last_truck_count`, `is_active`. "Truck active right now" is a **live telematics state**
(moving/parked/offline), answered from `crewlogic-trucks` (live), **not** from these tables.

## `usage_events` — metering (#90 = 21)

Scope `tenant_id` + `franchise_id` + `user_id`. `event_type` (ai.volume_check, ai.analyze_estimate, ai.job_plan,
photo.upload), `model`, `units` (numeric), `metadata jsonb`. For "how many AI calls / photos this month".

---

## Live vs. historical routing (per spec §2)

- **Live / "right now" / "today"** (trucks active, who's at HQ) → live edge functions
  (`crewlogic-trucks` state, `crewlogic-todays-workorders`), **not** raw SQL.
- **Historical / analytical** (avg dwell by day/hour, jobs completed, avg job size) → the tables above.

## Multi-tenant / config

`franchises` (scope by `id` uuid or `external_id`), `tenants` (boundary = `tenants.id`). #90 tenant is all
"vonigo" (`crm_type`/`pricing_source`/`customer_source`/`submission_target`). #90 uuid on **prod** and **dev**
differ (dev #90 = `44444444-4444-4444-4444-444444444444`) — the engine resolves it from the session, never hardcodes.

---

## Change log
- 2026-08-02 — v1 created from the dev schema profile (FW-62). Confirmed: `telematics_visits` empty (use
  `geofence_alerts`); `jobs`/`job_appointments` populated (Vonigo import snapshot, not live-synced);
  `customers` not mirrored for Vonigo franchises; facility name-vs-geofence_name mapping required.
