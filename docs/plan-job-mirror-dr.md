# Job Mirror — Vonigo Outage DR (FW-58)

**Status:** Design approved 2026-07-23 (owner). Next gate: migration `0067` + steady-state sync. Backfill run is BLOCKED until Vonigo recovers (Vonigo is the data source). Tracked as **FW-58** in `.HUB/Hub.md`.

## Purpose

A CrewLogic-side mirror of every Vonigo WorkOrder so a franchise can **find today's jobs, route trucks to them, and collect payment manually straight through a Vonigo outage**. Proven need: on 2026-07-23 Vonigo was down for hours and 100+ organizations could not find their jobs or customers. This turns CrewLogic from a Vonigo companion into a **continuity / insurance layer** — a distinct, sellable benefit.

## Scope & non-goals

- **Is:** a read-mostly disaster-recovery snapshot. Populated continuously while Vonigo is UP; served read-only (with a clear "showing last-known schedule — Vonigo is down" banner) while DOWN. The only degraded-mode write is manual payment capture.
- **Is NOT:** a functioning Vonigo replacement or a two-way sync. Simplicity wins — e.g. crew is a JSON blob, not a normalized child table (owner 2026-07-23: "this is a simple DR solution not a functioning vonigo replacement").

## Data source & backfill ("what/from where")

- **No existing CrewLogic table is migrated from — there is no job store today.** `estimates` holds CrewLogic-authored estimates, not the Vonigo schedule. The only source of truth for jobs is Vonigo.
- **Source:** Vonigo WorkOrders API (same source `crewlogic-todays-workorders` reads), per franchise, authenticated with each franchise's stored creds (`vonigo_credentials` → Vault).
- **Coverage:** all 9 Vonigo franchises — **all have creds on file** (28, 31, 36, 54, 56, 90, 102, 109, 116), verified 2026-07-23.
- **Window:** past 6 months + next 7 days (~190 days/franchise), paginated, **all statuses** (incl. cancelled/archived — history + payment reconciliation want the full record, unlike the live picker which drops cancelled).
- **Volume:** order tens of thousands of rows total; mostly text, cheap.
- **Backfill is one-time and blocked until recovery** — Vonigo is the source, so nothing to pull while it is down. The health monitor's "back UP" signal is the trigger to run it.

## Schema — `job_mirror` (proposed migration 0067)

One row per WorkOrder per franchise; upserted on every sync. The upsert key `UNIQUE (franchise_id, source, work_order_id)` is what makes cancellations and reschedules idempotent (a job is always the same row).

| Column | Type | Source / notes |
|---|---|---|
| `id` | bigint identity PK | surrogate |
| `tenant_id` | uuid not null → tenants(id) | tenancy |
| `franchise_id` | uuid not null → franchises(id) | tenancy |
| `source` | text not null default 'vonigo' | provider-neutral for the future |
| `work_order_id` | text not null | Vonigo WO objectID |
| `job_id` | text | Vonigo Job objectID (jobRel) |
| `service_date` | date | dateService decoded in the **franchise tz** |
| `service_epoch` | bigint | raw field 185 (naive-Eastern, per CLAUDE.md) |
| `start_minutes` | int | field 9082 (minutes from midnight) |
| `duration_min` | int | field 186 |
| `client_name` | text | clientRel.name / field 183 |
| `contact_name` | text | field 183 (on-site contact) |
| `address` | text | field 184 |
| `lat` / `lon` | double precision | geocoded |
| `phone` | text | **Q1** — field ID resolved at build via schema endpoint |
| `email` | text | **Q1** — field ID resolved at build |
| `items` | text | field 10336 (customer-safe) |
| `route` | text | routeRel.name |
| `crew` | jsonb | `[{id,name,title}]` — **Q4** display-only |
| `price` | numeric(12,2) | field 813 |
| `status` | text | status label |
| `status_option_id` | int | field 181 optionID |
| `label_option_id` | int | field 201 optionID |
| `notes` | text | field 200 — **confidential, role-gated on read (Q3)** |
| `raw` | jsonb | full WO payload (future-proofs new fields) |
| `vonigo_synced_at` | timestamptz | last successful pull of THIS row ("as of" staleness) |
| `removed_at` | timestamptz | reconcile tombstone — hard-delete insurance (see below) |
| `first_seen_at` | timestamptz default now() | |
| `updated_at` | timestamptz default now() | |

Indexes: `UNIQUE (franchise_id, source, work_order_id)`; `(franchise_id, service_date)` (the find query); `(service_date)` (retention prune).

## Decisions (Q1–Q5 + removed_at, owner 2026-07-23)

- **Q1 Phone/email** → YES, capture both. Field IDs resolved at build via the Vonigo schema endpoint (needs Vonigo up).
- **Q2 Forward window** → YES, **7 days**. Retention window = `[today − 6 months, today + 7 days]`.
- **Q3 Confidential notes (200)** → YES store, **role-gated** (owner/estimator only, never the customer-facing view).
- **Q4 Crew shape** → **jsonb** (DR display, not analytics; crew analytics come from live Vonigo in FW-57).
- **Q5 Scope** → all 9 Vonigo franchises.
- **removed_at** → added as cheap insurance even though Vonigo is not known to hard-delete.

## Mutation handling

- **Cancellations — handled.** A Vonigo cancel is a status change (optionID 162 Cancelled / 163 Cancelled-Today) on the same WorkOrder, not a deletion — the live picker still receives cancelled WOs and filters by status. Next sync re-pulls, `status_option_id` flips, the row persists (history), and the DR "route-to" view filters it out.
- **Reschedules — handled.** Keyed on `work_order_id`, not date. Same-WO date edit → the upsert rewrites `service_date`/`service_epoch`/`start_minutes` in place (the row moves days, no duplicate). New-WO + cancel-old → two rows, old flagged cancelled.
- **Far-future reschedule (beyond the 7-day window)** → lags until that date enters the window. Accepted (owner: an outage > a week means bigger problems).
- **Hard-delete (corner case)** → a removed WO produces nothing to upsert, leaving a ghost row. Guard: the sync's **reconcile** step stamps `removed_at` on any mirror row not seen in a fully-pulled day's result set. Start WITHOUT active reconcile to avoid false tombstones on partial/paginated pulls; enable if hard-deletes are ever observed. The column exists now so no later migration is needed.

## Retention

Daily cron (same pattern as `crewlogic-photo-sweep` / `crewlogic-signs-lifecycle`): delete rows with `service_date < today − 6 months`. Future/upcoming rows always kept.

## Access / RLS

- RLS enabled. Franchise reads only its own rows (same scoping as `estimates`). Writes are service-role only (the sync).
- `notes` is role-gated: exposed to owner/estimator only, never the customer-facing surface.

## Sync design (next gate after schema)

1. **Backfill** — one-time, day-by-day across the ~190-day window for all 9 franchises. Resumable, throttled (~1,700 Vonigo calls). Runs on the health monitor's recovery signal.
2. **Steady-state** — recurring pull of a rolling recent window + next 7 days (catch edits) + the daily retention prune. Cadence TBD at build.

## Open items (resolve at build / post-recovery)

- Vonigo WO field IDs for `phone` + `email` (schema-endpoint lookup — needs Vonigo up).
- Steady-state sync cadence.
- DR read UI: the "as of `vonigo_synced_at` — Vonigo is down" banner + status filtering; manual payment capture is a **separate later gate** (how manual payments reconcile back into Vonigo on recovery is out of scope for this table).

## Related

- Vonigo health monitor (shipped 2026-07-23) — the DOWN/UP signal that gates the backfill.
- FW-57 crew capture; `crewlogic-todays-workorders` (the WorkOrder pull this reuses).
