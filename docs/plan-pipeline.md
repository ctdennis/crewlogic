# Plan — Vonigo → CrewLogic Follow-up Pipeline (all 5 ops types)

**Status:** DRAFT — awaiting Owner approval (do not build yet).
**Tracks:** Hub FW "Vonigo date-range pull → CRM pipeline" + task #28 ("manage 5 ops types").
**Recognition reference (DONE/validated):** memory `vonigo-five-type-recognition` (probes vs #90, 2026-08-06/07).
**Owner scope decision (2026-08-10):** build **all 5 types**, plan doc first.

---

## 1. Goal

Today these five live in Vonigo with **no sales process** — they sit, appear in raw date order, and only advance if the *customer* happens to call back. The pipeline pulls them into CrewLogic and drives each one through a process — with **scheduling, reminders/alerts, and sales stages** — from its current status to a **booked job (the win)** or **closed–lost**. Nothing disappears until it's worked.

The unifying engine is **time-based follow-up**: every item has a *next action on a date*, due/overdue actions surface as **reminders/alerts** and on a **calendar**, and multi-touch **cadences (drip)** keep the contact going instead of dying after one attempt.

Per-type behavior (Owner context, 2026-08-10):

1. **Unbooked leads** — they come in and just sit; there's no lead-tracking pipeline. → put them in a pipeline with staged follow-up.
2. **Unconverted estimates** — quoted, not booked; **no drip today** — nothing happens unless the customer calls. → an automatic/scheduled follow-up cadence (call → email → text over days).
3. **Cancellations** — many are **reschedule-driven** ("cancelled because they need to reschedule"). → land on a **calendar with a reminder to call back in ~4–5 days** (esp. "Scheduling" reason, which is recoverable).
4. **Urgent callbacks (UCB)** — dropped on the calendar in date order; **all** need follow-up. → a worked backlog with reminders, oldest-first.
5. **Cases** — few have sales implications, but they usually carry a **note that requires a callback**. → surface the note + a callback reminder.

**Read-only to Vonigo in v1** (like Estimate Costing v1) — CrewLogic owns the follow-up/scheduling; no write-back to Vonigo. Write-back (convert a lead, close a case in Vonigo) is a future phase.

---

## 2. The 5 types — recognition (validated; see the memory for full detail)

| Type | Vonigo source | Recognition rule | Key fields to capture |
|---|---|---|---|
| **Lead** | `/data/Clients` (`method:-1, dateMode:1` created-date) | Client **stage field 123 == "Lead"** (vs "Account") | name, address; **phone/email from the linked Contact** (`/data/Contacts method:0` → field 1088 phone, email field) |
| **Unconverted estimate** | `/data/WorkOrders` (`dateMode:3`) | **label 201 ∈ {9996 Est-Completed-EstOnly, 9973 Est-Only, 9993 Lost}** (NOT 9975/9970 converted) | client, address, quote total, date, label |
| **Cancellation** | `/data/WorkOrders` (`dateMode:3`) → Job by jobID | **status 181 ∈ {162 Cancelled, 163 Cancelled-Today}**; **reason** via `/data/Jobs method:0` fields **974 category / 975 reason / 973 comments** | client, address, amount, cancel category+reason+comments, date |
| **UCB (urgent callback)** | `/data/WorkOrders` (`dateMode:3`) | WO **route relation objectID 2987** ("Pending - Other (URGENTCB)") — NOT in `/resources/routes` | client, address, date, backlog age |
| **Case** | `/data/Cases` (**plural `Cases` key** = franchise's own) | present + not deleted | f220 narrative, f219 type, f228 phone, f229 email, f11293 related appt |

**Gotchas already solved (in the memory, must carry into the build):**
- Vonigo `method:1` (single-retrieve) is unreliable — empty contacts, refuses cancelled jobs. Use `method:0` (search) / `-1` (list).
- `dateMode` is required or the date filter is ignored (returns oldest-of-all-time).
- Date epochs for Vonigo WO date fields = **naive-ET midnight** (not tz-aware) — but franchises span time zones, so resolve the franchise tz for the *display*/"today" logic (see `resolveTimezone`).
- **Cases** singular-key path is company-wide (can't franchise-filter) — use the plural key. #90 has 0 active cases today (build the plumbing; it'll light up for others / later).
- Cloudflare 1010 blocks non-browser callers — fine from Deno edge fns.

---

## 3. Architecture

Three layers, reusing existing infrastructure where possible:

1. **Pull** — new edge fn **`crewlogic-pipeline`** (MD5 Vonigo login via `_shared/vonigo.ts`; graceful-down handling already there). Actions: `sync`, `list`, `update`, `dismiss`.
2. **Store** — one relational table **`pipeline_items`** (per the "no JSON blobs for entity data" rule: queryable fields as columns + a `raw` jsonb snapshot for provenance). Optionally links to the FW-58 `customers` row when we already hold that customer.
3. **UI** — a new home card + **Pipeline** screen (tabs per type, per-item CRM controls, call/text/email like the outage-DR board).

Reuse: `_shared/vonigo.ts` (login + VonigoUnavailable→503), the WorkOrders-by-date pull pattern from `crewlogic-todays-workorders`/`crewlogic-dispatch`, the contact phone/email fetch pattern, and the DR board's call/text/email link helpers.

---

## 4. Schema — `pipeline_items` (one table, type-discriminated)

```
pipeline_items
  id                uuid pk
  tenant_id         uuid not null
  franchise_id      uuid not null
  type              text not null    -- lead | unconverted_estimate | cancellation | ucb | case
  -- provenance / idempotency
  source_provider   text default 'vonigo'
  source_object     text             -- client | workorder | job | case
  source_external_id text not null   -- Vonigo objectID (client/WO/case id)
  vonigo_link       text             -- deep link into Vonigo
  -- denormalized customer + item detail (load-bearing for the list, no blob-cracking)
  customer_name     text
  phone             text
  email             text
  address           text
  zip               text
  amount            numeric          -- quote/job total where applicable
  reason            text             -- cancellation category/reason, case type
  detail            text             -- cancel comments, case narrative, etc.
  occurred_at       timestamptz      -- created (lead) / service / cancel / opened (case) date
  raw               jsonb            -- full source snapshot for provenance
  -- CRM workflow (CrewLogic-owned; preserved across re-syncs)
  stage             text default 'new'   -- new | contacted | working | won | lost | resolved | dismissed
  assigned_to       text             -- profile email/id
  next_action_at    timestamptz      -- the tickler the calendar/alerts fire on (= next open touch's due_at)
  cadence           text             -- which follow-up template is running (e.g. 'estimate-drip', 'reschedule-5day')
  notes             text
  -- housekeeping
  created_at        timestamptz default now()
  updated_at        timestamptz default now()
  last_synced_at    timestamptz
  unique (tenant_id, type, source_external_id)
```

**Follow-up touches (the reminder/calendar/drip engine):**

```
pipeline_touches
  id                uuid pk
  pipeline_item_id  uuid not null references pipeline_items(id) on delete cascade
  due_at            timestamptz not null  -- when this touch is due (drives calendar + alerts). timestamptz (not date)
                                          -- so a timed appointment can sync 1:1 to an external calendar later; an
                                          -- all-day reminder just uses local-midnight.
  channel           text             -- call | email | text | note
  status            text default 'scheduled'  -- scheduled | done | skipped
  auto              boolean default false     -- true = a drip step CrewLogic can send automatically (email/text)
  note              text
  done_at           timestamptz
  created_at        timestamptz default now()
```

- A pipeline item has an ordered set of **touches** — the scheduled next actions. `pipeline_items.next_action_at` mirrors the earliest open touch (denormalized for fast calendar/alert queries).
- **Cadence templates** seed touches when an item enters a stage (e.g. an unconverted estimate → `estimate-drip`: call @ day 1, email @ day 3, text @ day 7, call @ day 14; a reschedule cancellation → `reschedule-5day`: call @ day 5). Templates are config (owner-tunable), not code.
- Completing a touch (or advancing the stage) schedules/opens the next; overdue open touches are the "needs attention" + alert feed.
- **v1: ALL touches are human reminders — NO automatic sending** (Owner 2026-08-10). The engine *schedules and reminds*; a person makes the call / clicks send. The `auto` column is reserved for a later **automated-drip** phase, which is a separate decision because it's outbound customer contact: either (a) hand off to **HubSpot / Mailchimp** (likely path), or (b) send internally — which first needs a per-franchise design (which from-address/domain each franchise sends as, deliverability, opt-out). Not in v1.

- **Idempotent upsert** on `(tenant_id, type, source_external_id)`. Re-sync updates ONLY source-derived columns (customer/amount/reason/raw/last_synced_at); it **never** clobbers the CRM columns (stage/assigned_to/follow_up_at/notes) — those are CrewLogic's.
- RLS on, no public policy — edge/service-role only (same posture as `franchise_route_types` / `estimate_costings`).
- Indexes: `(franchise_id, type, stage)`, `(franchise_id, follow_up_at)`.

**Open:** whether to FK `pipeline_items.customer_id → customers(id)` (FW-58 model) or keep contact fully denormalized. Lean: denormalized now (a lead often isn't a `customers` row yet); add the link later if we want a unified customer view.

---

## 5. Sync design

**`crewlogic-pipeline` action `sync` {franchiseID, days|dateStart/dateEnd, types?}`:**
- For each requested type, run its validated recipe for the window, map → `pipeline_items` rows, bulk-upsert (idempotent).
- Preserve CRM fields (see above). Stamp `last_synced_at`.
- Franchise-scoped; tz-aware "today"/window.

**Cadence (recommended):**
- **Daily scheduled sync** per Vonigo franchise (a rolling recent window — e.g. last 30–60 days) via a cron, so new leads/cancellations/estimates land automatically. (Reuse the multi-franchise cron pattern from FW-58's `crewlogic-vonigo-sync`.)
- **On-demand refresh** from the UI (a "Sync now" / date-range pull) for a deeper look-back.
- Not minute-critical (unlike dispatch), so daily + on-demand is enough. **Open for Owner:** daily fine, or faster?

**Retention / look-back window:** **rolling 30 days** (Owner 2026-08-10) — daily sync pulls the last 30 days; on-demand "Sync now" can reach further. Items already in the pipeline stay (with their CRM state) even as they age past 30 days until worked to won/lost/dismissed; the 30-day window only bounds what NEW items get pulled.

---

## 6. Pipeline UI

- **Home card:** "Pipeline" (customer-facing name TBD — Owner call; e.g. "Follow-ups" / "Pipeline" / "Win-back").
- **The Pipeline screen — ONE unified list, not tabs** (Owner 2026-08-10: the whole point is centralization — these are scattered all over Vonigo; don't make users search in five places). Every item (lead / estimate / cancellation / callback / case) is **one row in a single list**, each row carrying a **type badge/indicator** (colored chip: Lead · Estimate · Cancellation · Callback · Case). A **type filter** (multi-pick chips with counts, same pattern as the dispatch route-type filter) narrows the list; default view = "**needs attention**" (new + touches due/overdue, most-overdue first). Per item row: **type badge**, customer, contact chips (📞 call / 💬 text / ✉️ email — reuse DR board helpers), amount/date, reason/note (cancellations show category+reason; cases show the narrative note), the **cadence + next touch** ("Next: call · due Aug 15"), and CRM controls: **stage** dropdown, **assign to**, **notes**, **dismiss**. Working a touch = "Done" (logs it, opens the next in the cadence) or "Snooze/reschedule" (moves `due_at`).
- **Reminders live IN THE DISPATCH CALENDAR — one place** (Owner 2026-08-10). The dispatch board already has a time axis across the top; a **red dot next to a time** marks that follow-up activities are due then. **Click the dot → a popover lists the due activities** (customer, type, action, call/text/email chips, "Done/Snooze") — so the dispatcher sees follow-ups right alongside the day's jobs without leaving the board. In-app only (no email/text reminders in v1). The standalone Pipeline screen is where you *manage* the pipeline; the dispatch calendar is where due reminders *surface*.
- **Filters (Pipeline screen):** by stage, assignee, due window. Search by name.
- Later: bulk actions (assign N, email N) like the DR board; CSV export; kanban; a dedicated month calendar if the dispatch-board dots aren't enough.

**CRM stage taxonomy (proposed; Owner to confirm):** `new → contacted → working → won / lost` (+ `resolved` for cases, `dismissed` for noise). Same set across types keeps it simple; cases use resolved instead of won/lost. "**Won**" = booked a job.

**Cadence templates (proposed defaults; Owner-tunable):**
| Type | Cadence | Touches |
|---|---|---|
| Estimate | `estimate-drip` | call d1 · email d3 · text d7 · call d14 |
| Cancellation (reschedule) | `reschedule-5day` | call d5 (then working) |
| Lead | `lead-followup` | call d1 · text d2 · email d5 |
| UCB | `ucb-now` | call d0 (today), oldest-first |
| Case | `case-callback` | call d1 (surface the note) |

---

## External calendar integration (Google Calendar etc.) — DEFERRED (post-v1)

**Not gating P1.** In v1, reminders live in the CrewLogic dispatch calendar (red dots). Pushing them out to a calendar *program* is a later phase that just reads from `pipeline_touches`. Options captured so we build P1 calendar-ready:

- **A · ICS subscription feed** (one-way, universal) — a secret per-user/franchise `.ics` URL any calendar app subscribes to. Cheap; works with Google/Apple/Outlook. Caveat: **Google refreshes external ICS slowly (hours) with weak alerting**; Apple/Outlook refresh fast.
- **B · Google Calendar API push** (real-time, native reminders) — create/update events in a shared "CrewLogic Pipeline" Google calendar via OAuth. Incremental for us (we already use Google sign-in → add the `calendar.events` scope). Google-only.
- **C · CalDAV** (two-way) — heavy; only if the calendar must edit back into CrewLogic. Skip unless needed.

Recommended phasing: native dispatch reminders (v1) → **A** ICS feed (universal overlay) → **B** Google API push to a shared pipeline calendar (real-time Google alerts).

Deferred decisions (do NOT block P1): whose calendar (shared franchise vs per-assignee), reminders-only vs appointments too, which apps to support.

**The one P1-affecting choice:** to keep later calendar sync migration-free, `pipeline_touches.due_at` is a **`timestamptz`** (supports timed appointments, not just all-day date reminders), and future sync columns (e.g. `calendar_event_id`, `calendar_synced_at`) are additive later. Reflected in §4.

## 7. Build phases

- **P1 — Schema + pull (server).** Migrations `pipeline_items` + `pipeline_touches`; `crewlogic-pipeline` `sync` implementing all 5 recipes; API-smoke each type against #90 (+ #31) on dev.
- **P2 — List + CRM update (server).** `list` (filter by type/stage/assignee/due) and `update`/`dismiss`/`touchDone`/`snooze`; cadence-template seeding of touches on stage entry; CRM/touch fields preserved on re-sync. Smoke.
- **P3 — Pipeline screen (client).** Pipeline card + screen: ONE unified list with per-row type badge + a multi-pick type filter + counts, item rows with contact chips + next-touch + CRM controls, "needs attention" default. Gate: open to **testers** (see §8.9) — not #90/Kevin-specific.
- **P4 — Dispatch-calendar reminders.** Red dots on the dispatch board's time axis for due follow-ups + click-to-popover activity list (Done/Snooze). In-app only. This is the "everything in one place" surface.
- **P5 — Scheduled sync.** Daily multi-franchise sync cron + "Sync now"; retention window. (No auto-drip in v1 — touches stay human reminders.)
- **P6 — QA + promote.** Right-sized test plan; owner-gated prod promotion (migrations + edge fn + cron + merge).
- **Future (P7+):** automated drip (HubSpot/Mailchimp handoff, or internal per-franchise sender); Vonigo write-back (convert lead / close case); unified customer view (FK to `customers`); bulk actions; kanban; month calendar.

---

## 8. Decisions

**Resolved (Owner 2026-08-10):**
1. **Name** = **Pipeline**.
2. **Stages** = `new → contacted → working → won/lost` (+ resolved for cases, dismissed for noise). ✅
3. **No auto-send in v1** — all touches are human reminders. Automated drip is a future phase (HubSpot/Mailchimp handoff likely; internal sending would need a per-franchise from-address/deliverability design first).
4. **Reminders surface IN THE DISPATCH CALENDAR** (one place) — red dot on the board's time axis → click → due activities. In-app only.
5. **v1 read-only to Vonigo** (CrewLogic-side follow-up only), like Estimate Costing v1.

**Resolved (Owner 2026-08-10, round 2):**
6. **Look-back = 30 days** (rolling), daily auto-sync + on-demand "Sync now". (Was 90; 30 is enough.)
7. **Gating = open to all testers** (not #90/Kevin-specific). Gate on tester access (dev + `subscription_status='tester'` + super-admin). **Monetization:** Pipeline is a **new sellable feature** needing its own entitlement/feature-flag and a **potential price bump** — track under the payments plan; ship gated-to-testers now, wire the paid entitlement before general availability. (See `docs/plan-payments.md` + memory `payments-processor-and-seats-decision`.)
8. **Cases = build it, but NO per-type tabs.** One centralized list (§6): all types in a single list with a per-row type badge + a type filter. The whole point is one place, not five.

**Still to confirm before/at P1:**
9. **Cadence templates** — are the proposed per-type cadences (§6 table) about right for a first pass? (Config, easy to tune later.) — *lean: use the defaults.*
10. **Assignment** — v1 keeps an `assigned_to` field but defaults to a **shared franchise queue** (assignment optional), OK? Or force per-user assignment?

---

## 9. Reuse / dependencies

- `_shared/vonigo.ts` — login + graceful-down.
- WorkOrders-by-date + contact phone/email fetch patterns (from `crewlogic-todays-workorders`, `crewlogic-dispatch`, the DR importer).
- FW-58 canonical model (`customers`, `external_refs`) — optional linkage.
- DR board call/text/email + CSV/bulk helpers — reuse in the UI.

## No follow-up actions yet — this is a plan for approval; on approval it converts to phased tasks tracked in the Hub FW row.
