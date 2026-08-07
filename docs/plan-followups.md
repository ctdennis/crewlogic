# Follow-Ups Pipeline — Plan

**Status:** DRAFT for owner review (2026-08-07). No code yet.
**Tracking:** `.HUB` / TodoWrite task #28 ("Vonigo manage 5 ops types").
**Owner decisions still open:** see [§11](#11-open-decisions).

## 1. Goal

Turn the five recurring Vonigo "loose ends" — leads that never booked, estimates that never
converted, jobs cancelled for scheduling reasons, urgent call-backs, and cases — into a single
**actionable pipeline** the office can work: see them, contact the customer in one click, move
them through dated stages, schedule the next touch, get reminded on hot leads, and hand the list
off to HubSpot / an email tool. Recovering even a fraction of scheduling-cancels and stale leads
is direct revenue.

## 2. The five follow-up types (recognition — DONE, validated against live Vonigo)

| Kind | How we detect it (Vonigo) | #90 volume (sample) |
|---|---|---|
| **lead** (unbooked) | Client **stage field 123 = "Lead"** (vs "Account"); pull `/data/Clients` `franchiseID:90, method:-1, dateMode:1`, keep 123=Lead. Phone on the **contact** object field 1088 (method 0), email where present. | 23 in 8/4–8/6 (all had phone, ~half email) |
| **cancel** (scheduling) | Cancelled WO (status 162/163) → its **Job by `jobID` (method 0)** → cancel **category 974 = Scheduling** (reason 975, comments 973). Method 1 refuses cancelled jobs — must use method 0. | 16 of 48 July cancels |
| **unconverted_estimate** | WO **label field 201 ∈ 9996 (Est-Completed-Est.Only) / 9973 (Est-Only) / 9993 (Lost)** | 12 in July |
| **ucb** (urgent call-back) | WO **route relation objectID 2987** ("Pending-Other / URGENTCB") — not in `/resources/routes`; read the route off each WO. | 6 current |
| **case** | `/data/Cases` **singular `Case` key** (whole Junkluggers instance; plural `Cases` = the calling franchise's, all deleted for #90). | 0 active for #90 — dormant; include the plumbing, expect empty |

Full API detail lives in memory `vonigo-five-type-recognition`.

## 3. Data model — a `followups` row + a `followup_events` log

One unified table (they share one lifecycle + core fields; `kind` enum → reuse one UI). A separate
**append-only events log** timestamps every stage move and contact — the single source of truth for
**per-stage date tracking (§4)** and **today's activity reporting (§8)**.

```
followups
  id                uuid pk
  franchise_id      uuid           -- tenancy (scoped like everything else)
  tenant_id         uuid
  kind              text           -- lead | cancel | unconverted_estimate | ucb | case
  source_type       text           -- vonigo object: client | workorder | job | case
  source_id         text           -- Vonigo objectID/jobID → UNIQUE(franchise_id, kind, source_id): re-sync UPDATES, never duplicates
  customer_name     text
  phone             text           -- sms:/tel: + export
  email             text           -- mailto: + export
  town              text
  vonigo_created_at timestamptz    -- when the lead/cancel/etc. happened (drives "age")
  label             text           -- kind context: cancel reason, estimate outcome, route name…
  detail            jsonb          -- raw reason codes, appt#, comments, address, etc.
  status            text           -- current PIPELINE STAGE (§4), default 'new'
  stage_since       timestamptz    -- when the CURRENT stage began (cached; full history in events)
  is_hot            boolean        -- priority flag → reminders (§7)
  followup_at       timestamptz    -- NEXT scheduled touch (§7 scheduling + reminders)
  assigned_to       text           -- profile/email (optional)
  notes             text           -- free-text
  last_touched_at   timestamptz    -- when a human last acted
  synced_at         timestamptz    -- last time the sync saw it in Vonigo
  auto_resolved     boolean        -- closed by the system (re-booked/converted), not a human
  created_at / updated_at

followup_events            -- append-only audit + reporting feed
  id             uuid pk
  followup_id    uuid → followups
  franchise_id   uuid
  event_type     text     -- stage_change | contact | note | snooze | hot | sync | auto_resolve
  from_stage     text     -- (stage_change)
  to_stage       text     -- (stage_change)
  channel        text     -- (contact) sms | call | email
  detail         text
  actor          text     -- profile email, or 'system'
  created_at     timestamptz
```

`source_id` uniqueness is the anti-dup key. Per-stage "date tracking" = the first `stage_change`
event into each stage (and `stage_since` cached on the row). RLS + franchise scoping as usual.

## 4. Classic pipeline management, dated (v1 — required)

A **"Follow-ups" screen** with a **classic stage board** — columns are pipeline stages, cards are
follow-up items, counts on each column header.

**Stages (proposed, owner-tunable):** `New → Contacted → Won → Lost` (+ a **Snoozed** state).
- **Every stage move is dated** — writes a `stage_change` event + updates `stage_since`. Cards show
  "in New 3 days", "Contacted 8/6", etc.; time-in-stage is visible and reportable.
- **Filter by kind** via tabs: *Leads · Scheduling-Cancels · Unconverted Estimates · UCB · Cases* (+ counts), or "All".
- **Move a card** — drag-drop (desktop) and/or a stage dropdown (mobile-safe).
- **Card shows:** customer · town · age · kind badge · context (cancel reason / estimate label) · contact-present dots · next-touch date · 🔥 if hot.
- Reuses the dark card / `.btn-surface` styling + dispatch board patterns.

## 5. Per-item actions — one-click, zero integration

Each card carries the customer's contact, so actions are native links (no platform, no cost, works today):
- **Text** → `sms:+1XXXXXXXXXX` (optional pre-filled body) — opens your Messages app; send manually.
- **Call** → `tel:` · **Email** → `mailto:`
- **Add note · change stage · mark hot · snooze/schedule next touch**
- Each contact writes a `contact` event (channel), so "who did we text/call and when" is tracked.

## 6. Hand-off — load to HubSpot / email marketing

Universal export first: select cards (or a lane) → **Export CSV**
(`name, phone, email, town, kind, reason/label, age, status, next_touch`). Imports straight into
HubSpot / Mailchimp / Constant Contact — no API, no OAuth.
- **v2 (optional):** direct **HubSpot API push** (auto-create contacts/deals + field mapping). Deferred.

## 7. Scheduling, reminders & hot leads

- **Scheduling:** every item has a **`followup_at`** (date/time) — "schedule next touch." Set it when
  snoozing or after a contact ("call back Thursday 2pm"). Snoozed cards drop off the active board until due.
- **Hot leads:** an **`is_hot`** flag (one tap). Hot items sort to the top and drive reminders.
- **Reminders (v1, in-app + digest):**
  - **In-app:** a **Due / Overdue** lane (or badge) surfaces items whose `followup_at ≤ now`, hot ones first — the office sees "these need a touch today" on open.
  - **Daily email digest (optional):** a cron (extend `crewlogic-followups-sync` or a sibling) emails
    the office each morning via **`crewlogic-notify`**: hot leads due/overdue + counts. No new infra.
  - (Integrated SMS reminders / push = later, with real texting.)

## 8. Today's activity — very high-level list reporting

A compact **"Today" summary** at the top of the Follow-ups screen (franchise-local day), read from
`followup_events` + `followup_at`:

- **New today · Due today · Contacted today · Won today · Lost today · Overdue** — count chips, each
  click-through to that filtered list.
- Kept deliberately high-level (a daily pulse, not analytics). Later this same query can back a
  `crewlogic-analysis` skill ("what's my follow-up activity today") so it's answerable by voice too.

## 9. Sync — keep the pipeline current

Scheduled edge function **`crewlogic-followups-sync`** (daily + on-demand) per franchise:
1. Pull each kind (the §2 recipes), resolving contact phone/email per item.
2. **Upsert by `source_id`** — new items → `new` (writes a creation event); existing items refresh
   Vonigo context without disturbing human-set `status`/`notes`/`followup_at`.
3. **Auto-resolve:** items resolved in Vonigo (scheduling-cancel re-booked, lead → "Account", estimate
   converted) → `won` + `auto_resolved=true` + event, so the board doesn't go stale. (Never source
   cancels from CrewLogic's own cancel action — multi-part jobs are cancelled in Vonigo and would be missed.)

## 10. Build phases (proposed)

- **P1 — spine:** migrations for `followups` + `followup_events`; `crewlogic-followups-sync` for
  **scheduling-cancels first** (incl. contact resolution). Smoke on dev.
- **P2 — dated pipeline UI:** Follow-ups screen — stage board, kind tabs, cards, drag/move (writes
  dated stage events), counts, Today summary chips.
- **P3 — actions & scheduling:** sms:/tel:/mailto: (contact events), notes, mark-hot, snooze/next-touch,
  Due/Overdue lane, CSV export.
- **P4 — reminders + generalize:** daily email digest via `crewlogic-notify`; add the other kinds to the
  sync (leads, unconverted estimates, UCB, cases) — same table + UI.
- **P5 (later):** HubSpot direct API, integrated/automated texting, Analysis-Engine "today's activity" skill.

## 11. Open decisions

1. **Stages** — is `New → Contacted → Won → Lost` (+ Snoozed) right, or add an "Attempted / no-answer" column?
2. **Where it lives** — standalone **Follow-ups** screen (rec) vs. a section inside Dispatch?
3. **Assignment** — per-item owner/assignee in v1, or a shared list to start?
4. **First kind** — confirm **scheduling-cancels** built first, then generalize?
5. **Reminders delivery** — in-app Due/Overdue lane only for v1, or also the morning email digest?
6. **"Hot" definition** — purely a manual flag, or also auto-hot by a rule (e.g. lead < 48h old, or a
   scheduling-cancel with "date no longer works")?

## 12. Follow-up actions

Tracked under task #28. Next action: owner review/redline of this plan → then P1 (tables + cancel sync).
