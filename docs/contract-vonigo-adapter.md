# Contract — Vonigo Read-Only Adapter (Outage DR) — FW-58

**Status:** DRAFT for Owner sign-off (contract-before-code gate 1). No schema/code until approved. Supersedes `docs/plan-job-mirror-dr.md`. Builds on the approved canonical job model (`docs/contract-jobs-schema.md`, 2026-07-19).

## 1. Purpose & scope

A **read-only Vonigo adapter** that imports Vonigo WorkOrders into the **canonical job model** so a franchise can find today's jobs, route to them, and collect payment manually **through a Vonigo outage**. It is the first real consumer of the canonical model and the concrete proof of the "adds a CRM = rows, not columns" framework.

- **In:** read-only import (one-time backfill + steady-state sync) from Vonigo → `jobs` / `job_appointments` / `customers` / `external_refs`; retention; a **minimal read path** for the DR board.
- **Out (own contracts):** writing back to Vonigo; native job authoring (create/update/transition); ServiceTitan; payments/invoicing; the full dispatch-board UI. This adapter only READS Vonigo and WRITES our mirror.

## 2. Prerequisite (hard gate)

The canonical model is **dev-only** today — on prod only `customers` exists; `jobs`, `job_appointments`, `job_crew`, `job_item_locations`, `external_refs`, `routes`, `job_pick_options`, `franchise_job_counters` are **not promoted** (migrations 0052-0055). Shipping this feature to prod **requires promoting 0052-0055 first** (additive, empty tables, zero regression risk). That promotion is its own reviewed step before any adapter deploy.

## 3. Mapping — Vonigo → canonical

Idempotency key throughout: **`external_refs (entity_type, provider='vonigo', external_id)` → `crewlogic_id`.** Every sync resolves the canonical row by external ref, then upserts. Same WO → same appointment row (reschedule = date rewrite in place; cancel = status change) — no duplicates.

| Vonigo | Canonical | Notes |
|---|---|---|
| Job (`jobID`) | `jobs` row, `origin='import'` | external_ref `entity_type='job'`, `external_id=jobID` |
| WorkOrder (`workOrderID`) | `job_appointments` row | external_ref `entity_type='appointment'`, `external_id=workOrderID`. `scheduled_date`=field 185 decoded in franchise tz; `start_minutes`=9082; `duration_minutes`=186 |
| client | `customers` row | external_ref `entity_type='customer'`. **`phone`/`email` live here** (resolves Q1 — customers already carries them) |
| field 184 / lat-lng | `jobs.service_address` + `service_lat/lng` | denormalized per contract §3.1 |
| field 200 (notes) | `jobs.notes_internal` | CONFIDENTIAL, never customer-facing (resolves Q3) |
| field 10336 (items) | `jobs.items_description` | customer-safe |
| status 181 + label 201 | see §4 status rule | |
| route | `job_appointments.route_id` (+ `routes`) | see Open Decision O2 |
| crew relations | see Open Decision O1 | `job_crew.profile_id` needs a native login — Vonigo crew are Vonigo Users |
| total/price | see Open Decision O3 | canonical model defers money to payments; DR needs the amount to collect |

## 4. Status rule (avoids the reason-constraint traps)

`jobs.status` for imported rows is restricted to **`scheduled`** or **`completed`** only. Cancellation is reflected at the **appointment** level (`job_appointments.status='cancelled'`, which needs no reason), NEVER by setting `jobs.status='lost'/'cancelled'` — those require `lost_reason_id`/`cancel_reason_id`+`memo` that a Vonigo import has no native value for. So the adapter never trips `jobs_lost_reason_chk`/`jobs_cancel_reason_chk`.

- Appointment: 160/161 → `scheduled`; 163 in-progress → `working`; 164/165 → `done`; 162/cancel variants → `cancelled`.
- Job: `completed` once all its appointments are `done`/`cancelled`; else `scheduled`.
- The DR board filters `cancelled` appointments out of the "route-to" list (keeps the row for history).

## 5. Sync & retention

- **Backfill (data migration):** one-time, day-by-day over `[today − 6 months, today + 7 days]`, **all statuses**, per franchise (all 9 Vonigo franchises have creds). Resumable, throttled. **BLOCKED until Vonigo recovers** (it is the source).
- **Steady-state:** recurring pull of a rolling recent window + next 7 days (catch edits) + a daily retention prune deleting imported rows (`origin='import'` / provider='vonigo') with `service_date < today − 6 months`. **Never** prunes native rows.
- **Staleness:** `external_refs.last_synced_at` is the "as of" marker; the DR board shows "showing last-known schedule as of <time> — Vonigo is down."
- **Hard-delete insurance:** optional reconcile stamps a tombstone on imported appointments not seen in a fully-pulled day. Off by default (cancellations are status changes, not deletes).

## 6. Read path (minimal)

Build only the **read-only slice** of the `crewlogic-jobs` API (contract §4): `list` (board query by date range) + `get` (one job). JWT-verified (customer data — not `--no-verify-jwt`), RLS via `current_franchise_id()`, `notes_internal` role-gated (owner/office only). Response shape per §4.1 (includes `externalRefs`, `startLocal`/`startUtc`/`timezone`). `create`/`update`/`transition`/`cancel` (native authoring) are deferred to their own contract. DR read reuses this — no separate DR-only endpoint.

## 7. Open decisions (need your call before build)

- **O1 — Crew display.** `job_crew.profile_id` requires a native CrewLogic login; Vonigo crew are Vonigo Users with no CrewLogic profile. For read-only DR I recommend **NOT populating `job_crew`**; instead carry Vonigo crew names in a small provider snapshot (see O4) for display only. (Full crew→login mapping is a native-authoring concern, later.)
- **O2 — Route.** Recommend **denormalize the route name** for DR display and leave `route_id` NULL unless a matching native `routes` row exists; optionally upsert a `routes` row per distinct Vonigo route later. Avoids inventing native route rows during a read-only import.
- **O3 — Amount to collect.** The canonical model deliberately has no price column (money → payments contract). DR "collect manually" needs the number. Recommend storing the Vonigo total in the **provider snapshot (O4)** as `import_total`, surfaced read-only on the DR board — NOT as a canonical price column (keeps the framework clean).
- **O4 — Provider snapshot sidecar.** To hold read-only, provider-specific DR extras (raw payload, `import_total`, crew-name display, route name) without polluting the canonical tables, recommend a **sidecar `job_source_snapshot(appointment_id, provider, raw jsonb, import_total numeric, crew_display jsonb, route_name text, synced_at)`** — rows, not columns, consistent with the framework. One small new table; the canonical tables stay untouched.

## 8. Build order (once approved, and Vonigo up)

1. Promote canonical model 0052-0055 to prod (gate §2).
2. Add the `job_source_snapshot` sidecar (if O4 approved) — one migration.
3. `crewlogic-vonigo-import` edge function: backfill + steady-state sync (maps §3, idempotent via external_refs).
4. Read-only `crewlogic-jobs` `list`/`get`.
5. Minimal DR board UI (reuses the canonical list shape + "as of / Vonigo is down" banner).
6. Resolve phone/email Vonigo field IDs (schema endpoint — needs Vonigo up), run the backfill.

## 9. Related

- `docs/contract-jobs-schema.md` — the canonical model (Owner-approved 2026-07-19).
- `docs/plan-job-mirror-dr.md` — SUPERSEDED prior design (standalone table); columns/decisions folded in here.
- Vonigo health monitor (shipped 2026-07-23) — the DOWN/UP signal gating the backfill.
- FW-58 in `.HUB/Hub.md`.
