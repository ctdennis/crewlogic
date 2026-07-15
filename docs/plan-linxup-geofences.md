# Plan — Linxup job geofences + move-reconcile + time-at-customer reporting

**Status:** DRAFT for Owner review · 2026-07-15 · no code yet
**Related:** the Motive design in `crewlogic-job-geofence-sync`, `crewlogic-geofence-create`,
`crewlogic-motive-webhook`, `crewlogic-linxup-webhook`; tables `job_geofences`, `geofence_alerts`.

## Goal
Bring Linxup franchises (e.g. #56) to parity with the Motive design — auto-create a per-job
"customer location" geofence each day, clean it up correctly when the job moves/completes, and
report **total time at each customer/job** alongside the transfer-station/recycling/donation
dwell data. Plus fix two gaps in the *current* Motive design while we're in here.

## Phase 0 — PREREQUISITE: does Linxup have a geofence create/delete API? (blocker)
The Motive design programmatically **creates and deletes** geofences via Motive's API
(`crewlogic-geofence-create` → Motive). Linxup today is **webhook-receive only** — we have no
Linxup API integration. Koby's fences ("Test Test", "SA Anaheim") were created **by hand** in the
Linxup UI.
- **Must confirm before anything else:** does Linxup expose an API to create/delete geofences
  programmatically, and can we get API creds for #56? (The push-API `3f8796…` key is for the push
  webhooks — likely not the same as a management API.)
- If **yes** → proceed with Phases 1–4.
- If **no** → auto-per-job geofences aren't possible on Linxup; fallback is manual fences +
  report only on what fires. This is an Owner/Linxup-support question, not a code question.

## Phase 0.5 — RESOLVED: Linxup management API confirmed
- Linxup HAS a REST API; key already stored as the `LINXUP_API_KEY` secret (dev + prod, same key =
  Owner's #90 account). Base `https://app02.linxup.com/ibis/rest/api/v2/`, auth `Authorization:
  Bearer <LINXUP_API_KEY>` — already proven by `_shared/telematics.ts` `/locations`.
- **Testing:** use the existing `LINXUP_API_KEY` against #90's Linxup.
- **Per-franchise follow-up (UI):** long-term each franchise inputs its OWN Linxup API key (like
  Motive). The per-franchise telematics-credential Vault + `get_telematics_credential` + legacy
  global-secret fallback already exist (see crewlogic-trucks) — so this is mostly a settings-UI
  field (`crewlogic-settings` saveTelematics) to capture the Linxup REST key per franchise, not new
  infra. Build the Linxup geofence path to read the per-franchise cred first, fall back to
  `LINXUP_API_KEY` (mirrors crewlogic-trucks).
- **Still needed:** the geofence CRUD endpoints under `/ibis/rest/api/v2/` (create/delete/list +
  payload). Either Owner supplies the Linxup REST docs, or probe with the existing key on dev.

## Phase 1 — Linxup create/delete + eligibility — ✅ BUILT + DEPLOYED TO DEV (2026-07-15)
- ✅ `crewlogic-geofence-create` now branches on the franchise's ACTIVE provider:
  - **create** — Linxup `POST /ibis/rest/api/v2/geofences` `{name, type:"Circle", points:[{latitude,longitude}], radius(MILES = radius_in_meters/1609.34), fenceGroup:"CurrentJob", color:"00ff00", status:"ACT"}` → returns `geofenceUUID`; Motive path unchanged.
  - **delete** — Linxup `DELETE /ibis/rest/api/v2/geofences/{geofenceUUID}` (Bearer); Motive unchanged.
  - Token resolves per-franchise via `get_telematics_credential`, with `tokenForProvider()` global-secret fallback (`LINXUP_API_KEY` / `MOTIVE_API_KEY`) — mirrors `crewlogic-trucks`.
  - Response now returns a **normalized top-level `geofence_id`** (Motive `geofence.id` / Linxup `geofenceUUID`) so the sync stores the right provider id for both.
- ✅ `crewlogic-job-geofence-sync` eligibility widened: `telematics_credentials … or(provider.ilike.motive, provider.ilike.linxup)`; create-result read changed to the normalized `gc.data.geofence_id` (legacy `.motive.geofence.id` kept as fallback).
- ✅ Keeps the existing `job_geofences` keying (`franchise_id + wo_id`, one active per WO).
- ✅ Settings UI for the per-franchise Linxup REST token **already existed** (`linxupApiToken` → `saveTelematicsProvider('linxup')`; backend `saveTelematics` was already dual-provider, per-provider Vault). Nothing new to build there.
- ✅ **Schema fix (migration 0042, applied dev):** `job_geofences.geofence_id` was **`bigint`** (Motive numeric ids). Linxup returns a `geofenceUUID` string, so the first create landed the fence in Linxup but the tracking-row insert threw `invalid input syntax for type bigint` — leaving an orphaned fence. Widened the column to **`text`** (all code paths already `String()`-wrap the id; existing Motive ids convert losslessly). **Prod needs 0042 applied at Phase-1 promotion.**
- ✅ **VERIFIED end-to-end on dev (2026-07-15):** with #90-dev Linxup-active (Owner pasted the REST token), a targeted create for wo `995483` (Bibee, Open) returned `created:1, errors:0`, fence `9f5666ec-…` recorded in `job_geofences` as text with `job_id`/name; delete returned Linxup 204. Both the orphan (pre-fix) and the verified fence were deleted from Linxup and the dev row removed — dev is clean.
- **Note (Phase 3):** `geofence_alerts.geofence_id` may also be bigint. Linxup fence-event webhooks currently store a numeric id (`agilisGeofenceId`) — confirm our CurrentJob fences fire enter/exit with a numeric id (fine) vs the UUID (would need the same text widening) when wiring per-job aggregation.

## Phase 2 — Reconcile-based move cleanup (fixes Motive too)
Today the sync is event-driven: it only deletes a geofence when it sees the WO **done/cancelled**
in the day's fetch. A Vonigo-side **move** never triggers CrewLogic, so the fence lingers to the
02:30 sweep (Owner-flagged). Fix:
- **Reconcile, not events:** on each pass, diff the day's **actual current job list** against active
  `job_geofences`; **delete any active geofence whose `wo_id` is no longer on today's schedule**
  (moved off / gone).
- **FLAG-GATED (2026-07-15):** the reconcile `moved_off` delete is behind `GEOFENCE_RECONCILE=1`
  (dev = on, prod = unset/off). Prod ships Phase 1 with UNCHANGED behavior (moved-off fences wait for
  the 02:30 EOD sweep) until reconcile is validated; flip the prod secret on to enable Phase 2.
- **Trigger on the CrewLogic board refresh** (the 90s auto-refresh + after-action reloads) so the
  map clears the moment a job moves off today — near-real-time. The 30-min cron stays as backstop. *(not yet wired)*
- **Guardrail:** reconcile only against a **successful, non-empty** job fetch, so a transient Vonigo
  failure can never wipe all geofences.
- Multi-appointment cancels stay in Vonigo (existing guard); reconcile cleans up once the
  appointment is actually off the schedule.
- **Open validation (Q-2):** does flipping a job to **invoiced (no payment)** change the Vonigo
  status to Completed/Archived (164/165)? If so it would trip the geofence delete. Owner tests one
  live; result decides whether "complete" should stay payment-only or include invoiced.

## Phase 3 — `wo_id` on `geofence_alerts` (report data) — ✅ BUILT + VERIFIED ON DEV (2026-07-15)
- ✅ Migration **0043** adds `geofence_alerts.wo_id` + `job_id` (text) + a `(franchise_id, wo_id)` index. Applied to dev.
- ✅ `crewlogic-motive-webhook`: populates `wo_id`/`job_id` from the `job_geofences` lookup it already does by `geofence_id` (extended the select). No name parsing.
- ✅ `crewlogic-linxup-webhook`: parses `#<woID>` from the fence name (reliable regardless of which id Linxup echoes), looks up `job_id` from `job_geofences`, and relabels entry/exit → `job_arrive`/`job_leave` for provider parity.
- ✅ **Verified (simulated real webhooks on dev):** a job fence-exit ("… · #995483 · …") stored `event_type=job_leave, wo_id=995483, job_id=858860, duration=2520`; a facility fence ("ABC Transfer Station", no `#`) correctly stored `wo_id=null, event_type=geofence_exit`. So `wo_id IS NOT NULL` cleanly = customer visit, `NULL` = facility visit — the discriminator Phase 4 needs.
- Motive path verified by parity/code-review (its `job_geofences`-by-`geofence_id` lookup already worked; Phase 3 only added 2 columns to the select + insert). Live Motive validation happens when real events fire post-promotion.

## Phase 4 — Time-at-customer + facility report (UI is first-class)
- Extend the existing Alerts Report (`openAlertsReport`) — it currently reports only facility
  visits (`event_type=geofence_exit`, classified Disposal/Recycling/Donation). Add **total time at
  each customer/job** from `job_leave` durations, grouped by `wo_id`, handling multi-truck /
  dump-and-return (multiple arrive/leave pairs per job → sum or first-arrive→last-leave).
- **UI requirements (Owner, hard):** must be genuinely usable at multi-customer scale — **sortable
  and filterable** (by customer, route, date range), scannable, not a raw dump. This is a design
  investment, not an afterthought.
- Add a **server-side date filter** (the report currently pulls the last 5000 exit rows
  client-side) so long custom ranges work.

## Build order / decisions to lock
1. **Phase 0 answer first** — Linxup geofence API existence + creds (Owner/Linxup). Everything hinges on it.
2. Then Phase 1 (Linxup create/delete) → Phase 2 (reconcile, benefits Motive immediately) → Phase 3
   (wo_id) → Phase 4 (report).
3. Q-2 invoiced test result (Owner) refines the Phase-2 delete trigger.
4. Dev-first throughout; Vonigo/Motive/Linxup are live systems (no sandbox) — validate on #90/#56
   with care; per the pricing/critical-path discipline, verify each geofence create/delete lands.
