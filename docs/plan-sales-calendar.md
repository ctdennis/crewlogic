# Plan — Sales-Activity Calendar (FW-64)

**Status:** DRAFT — awaiting Owner approval of direction before any code.
**Date:** 2026-08-11
**Owner ask (verbatim):** "we have sales activities, calls, visits, presentations, etc. these all get tagged to a calendar event with a date and time, contact information, phone, email, etc. If there is a dot at 5:30pm and it is 9am, it isn't even shown on the board ... many of our franchisees are one person operations ... next step might be to integrate with a calendar feature which is something we discussed originally."

---

## 1. Problem

The Follow-up Pipeline (FW / `crewlogic-pipeline`) surfaces WHO needs a touch (leads, open estimates, cancellations, urgent callbacks, cases). We tried to show timed follow-ups as dots on the **dispatch board**, and it broke on first contact with reality:

- Follow-ups have **no real clock time** — a touch's "time" was just when the sync ran (e.g. 5:27 PM).
- The dispatch board is a **fixed working-hours window for trucks** (~6 AM–3 PM). Anything outside it — or untimed — has no honest place on it (a 5:30 PM dot isn't even on the board at 9 AM).
- A truck-routing board is the wrong home for **office sales work** (calls/visits/presentations the operator does between jobs).

The right model for timed sales work is a **calendar event**: type + date + time + duration + contact (name/phone/email) + notes + outcome. That is a distinct object from both a Vonigo job (truck work) and a pipeline record (the CRM row).

### The operator context (the deciding factor)

Many franchisees are **one-person operations** — they run ops, accounting, marketing, AND sales. They do not want the pipeline in one place, jobs in another, and their calendar on their phone. They want **one view of their day**: the Vonigo jobs they're running *and* the calls/visits they've scheduled, on whatever device they're holding (usually their phone, in the field).

## 2. What a Sales Activity is

A first-class object, separate from a job and from a pipeline record:

| Field | Notes |
|---|---|
| `type` | call · visit · presentation · email · task (extensible) |
| `subject` | short title ("Call back Hines re: cellar cleanout") |
| `start_at` / `end_at` | date + time + duration (TZ-resolved per franchise — see the multi-tenant TZ rules in CLAUDE.md) |
| `contact_name / phone / email` | copied from the linked pipeline item, or entered for a standalone activity |
| `location` | address (for visits/presentations); enables map + drive-time later |
| `pipeline_item_id` | nullable link back to the lead/estimate/cancellation/UCB/case |
| `user_id` | which operator owns it (multi-person orgs) |
| `status` | scheduled · done · canceled · no-show |
| `outcome` | after completion: reached / left VM / booked / not interested / reschedule |
| `reminder_minutes` | lead time for the reminder |
| `notes` | free text |
| `google_event_id` | nullable — mapping for two-way Google Calendar sync (Phase 2) |

## 3. How it folds in the Follow-up Pipeline

The Pipeline and the Calendar are complementary, not competing:

- **Pipeline = the worklist.** "Who needs attention" (the CRM records + their due-date queue). Stays exactly as it is: grouped list, "needs attention," the per-day count pill on the dispatch as a heads-up.
- **Scheduling a follow-up with a time = creating a Sales Activity** linked to that pipeline item.
- **Untimed follow-ups stay a due-date queue** (today's count pill + the day list). **Timed activities land on the calendar** at their time. Nothing gets a fake time.
- The existing `pipeline_touches` cadence keeps generating **untimed due-dates**; the operator promotes any touch to a timed activity when it deserves one ("customer said call at 2").

This resolves the date-vs-time question cleanly: **date-only by default, time when it's real.**

## 4. The key decision — native calendar vs. Google Calendar sync

**Recommendation: native activity data model as the source of truth, a native in-app "My Day" view, AND two-way Google Calendar sync as the headline integration.** Reasoning:

- **Google Calendar sync is the high-value piece for solo operators.** We just put crewlogicai.com on **Google Workspace**, and most franchisees live in Gmail/Google Calendar. Pushing activities to *their* Google Calendar means: it shows on their phone, fires Google's native reminders, and needs no new habit or second app to check. (It also sidesteps the "cron cadence must match the UX promise" trap — Google owns the reminder delivery.)
- **A native in-app view still matters** for the "one view of my day" moment inside CrewLogic — jobs (from the Vonigo mirror) + activities on one timeline — and it works even for an operator who never connects Google.
- **Native data model, Google as a mirror/target.** `sales_activities` is the source of truth; Google events are created/updated/deleted from it and mapped by `google_event_id`. Optionally pull the operator's existing Google events for conflict awareness. This keeps us portable (a future Outlook/iCal sync is the same pattern) and never dependent on a third party for our own data.

## 5. Data model sketch (plan-level — NOT final schema)

Per the contract-before-code discipline, this is illustrative; the real schema is a later gate.

- **`sales_activities`** — the fields in §2, scoped by `tenant_id` + `franchise_id`, RLS on (service-role via an edge fn, matching the pipeline pattern).
- **`calendar_connections`** — per-user Google OAuth tokens (refresh token in Vault, like `vonigo_credentials`), the connected calendar id, sync state.
- **Evolve `pipeline_touches`?** Option A: leave touches as the untimed cadence, and "schedule with a time" creates a linked `sales_activity`. Option B: give touches an optional `scheduled_at` time and render timed ones as activities. **Lean A** — keeps the cadence engine simple and the calendar object clean. (Open decision D-3.)

## 6. Google Calendar integration approach (Phase 2)

- **OAuth scope:** extend the existing Google sign-in with `https://www.googleapis.com/auth/calendar.events` (or `calendar`). We already run Google OAuth for auth (`crewlogic-oauth-callback`) — this is an incremental-consent add, per-user opt-in.
- **New edge fn `crewlogic-calendar`:** create/update/delete a Google event from a `sales_activity`; store `google_event_id`; token refresh; (v2) pull events for conflict view. Deploy via the `deploy-fn.sh` guardrail (it is server-to-server / user-authed — confirm the public-list decision at build time).
- **Reminders** ride on Google (native push to the phone). No CrewLogic cron needed for reminders.
- **Account nuance:** the operator connects **their own** Google Calendar (their working calendar), not a crewlogicai.com service account — cf. the "Google accounts split: Drive vs mail" note (auth as the account that owns the calendar).

## 7. One-person-operation UX — "My Day"

- A **My Day** view (mobile-first): today's **Vonigo jobs** (from the `job_appointments` mirror) + today's **sales activities** on one vertical timeline.
- Tap a call/visit → contact card + one-tap **Call / Text / Email** + **log outcome** (reached / VM / booked / reschedule) → writes back to the activity and the linked pipeline item.
- Reschedule = pick a new date/time (reuses the reschedule modal we just built, extended with a time).
- This is the surface a solo operator opens each morning to run ops + sales from one screen.

## 8. Phasing

- **Phase 1 — Native activities + My Day (no external dependency).** `sales_activities` table + a "Schedule activity" action on a pipeline item (type + date + time + contact) + the native My Day / calendar view (jobs + activities). Untimed follow-ups stay the count pill + day list. Ships value with zero Google dependency.
- **Phase 2 — Google Calendar two-way sync.** OAuth scope, `crewlogic-calendar`, `google_event_id` mapping, native reminders. The headline integration.
- **Phase 3 — Conflict awareness + team.** Pull Google events to show conflicts; recurring activities; per-user calendars for multi-person franchises; drive-time from a visit's location (reuse the dispatch distance engine).

## 9. Open decisions for Owner

- **D-1. Scope of v1:** native My Day only (Phase 1), or go straight to Google sync (Phase 1+2)?
- **D-2. Native view + Google both, or Google-only?** (Recommendation: both, native data model as truth.)
- **D-3. Touch model:** keep `pipeline_touches` untimed + separate `sales_activities` (lean A), or add a time to touches (B)?
- **D-4. Do activities also appear on the dispatch board** (as an overlay/lane), or **only** in the My Day / calendar view? (Recommendation: only the calendar view + the existing dispatch count pill — keep the truck board clean.)
- **D-5. Per-user calendars** at launch (multi-person orgs) or single-operator first?

## 10. Interim state (holds until this ships)

The current **date-based pipeline + dispatch per-day count pill** (v5.124.13, dev) is stable and does not block any of this. **Prod promotion is HELD** at Owner's direction pending this plan's approval and a decision on how far the calendar changes the pipeline surfaces. Nothing pipeline-related is on prod beyond the earlier v5.123.3 (#90-gated).

## 11. Related

- `docs/plan-pipeline.md` — the Follow-up Pipeline this extends.
- `.HUB/Hub.md` FW-64 — tracking row for this plan.
- CLAUDE.md "Time zones & dates (multi-tenant)" — all activity times must be TZ-resolved per franchise.
- Memory: `crewlogic-email-infra` (Google Workspace on crewlogicai.com), `google-accounts-split-drive-vs-mail` (connect the account that owns the calendar).

---

### Next action

Owner: approve the **direction** (and answer D-1 / D-2 as the two that gate scope). On approval, the first gate is the API/schema contract for `sales_activities` (contract-before-code), not implementation.
