# Plan — Voice AI Dispatcher (move / cancel jobs in Vonigo by voice)

**Status:** DRAFT — awaiting Owner approval. No code until approved (strategy mode).
**Author:** Architect pass, 2026-06-20. **Repo:** crewlogic (single-file PWA + Supabase edge fns).

## Goal
A **"Manage Jobs"** voice feature. The owner/dispatcher speaks a natural-language command; an AI agent
(a) answers availability questions, (b) resolves move/cancel commands, asking only what it can't infer,
(c) **always confirms** the resolved action (by voice OR tap), then (d) executes in Vonigo and reads back the result.

Three capabilities:
1. **Availability query** — *"What's open Thursday afternoon?"* → list open slots (zip-zoned routes first).
2. **Move** — *"Move the second appointment on Route 1 to Route 3"* (positional addressing; today implied).
3. **Cancel** — *"Cancel job 2 on Route 3"* (with reason capture).

## Locked decisions (Owner, 2026-06-20 / -21)
1. **Feature:** "Manage Jobs" umbrella; Move + Cancel are sub-actions. **Voice-command ONLY** — no manual
   move/cancel UI to build (Vonigo already does manual moves). The app UI is just the voice + confirm layer.
2. **Three capabilities:** availability query, move, cancel (all v1).
3. **Job addressing:** by route + **stop position** ("second appointment on Route 1") and/or time/client; **today is the default day** unless stated.
4. **Move target time:** if the command names a route but **no new time**, **keep the job's current clock time** on the target route. Verify it's open there (zip-zoned); if open → confirm; if not → flag and offer nearest open slots.
5. **Route choice:** dispatcher may name the target route, OR ask the AI to recommend open slots across routes. The AI **flags whether a route is zoned for the job's zip** (✓ zoned vs ⚠ owner-override).
6. **Slots:** discrete **open booking times** from Vonigo availability (zip-zoned, duration-fit). Never free-entry.
7. **Confirmation:** ALWAYS confirm before any Vonigo write — accept **voice ("yes") OR tap**. No trusted fast-path.
8. **Voice surface:** browser microphone in the PWA (Web Speech API). No phone/IVR in v1.

## UI — what to show (voice-only; echo-before-act)
The screen is a thin conversational confirm layer, not a form. Three artifacts:
- **Resolved-job echo:** after a positional command, show WHICH job was resolved (route, stop#, client, time, address) so a mis-hear is caught visually before anything moves. Ambiguous → ask, don't guess.
- **Proposed target + zoning flag:** target route + day + time, tagged `✓ open · ✓ zoned for <zip>`; a non-zoned route shows `⚠ not the zoned route for <zip> — override?`.
- **Confirm card:** `From: … / To: …` (or cancel details) with `[Confirm] [Adjust] [Cancel]`; confirm by voice or tap.
- **Availability-query response:** open slots grouped by route, **zoned routes first (✓)**, override routes separated.

## Confirmed API building blocks (all validated against #90 during recon)
- **Routes for a day:** `/resources/routes` (method `-1`, `dayID`) → routeID, code (title), isActive.
- **Jobs on routes:** `/data/WorkOrders` (date bracket, naive-Eastern epochs) → per job: route relation, **start (field 9082, min-from-midnight)**, **duration (field 186, min)**, client (183), status (181), address (184), price (813).
- **Open move-targets:** `/resources/availability` (method `0`; `dateStart/dateEnd` true-Eastern epochs, `duration`, `locationID`, `serviceTypeID`, `pageNo/pageSize`). Returns `[{dayID, routeID, startTime(min-from-Eastern-midnight)}]` — **already excludes closed hours AND booked jobs** (open only).
  - **Zip zoning (validated, incl. a live template edit):** pass `zip` → only the route(s) zoned for that zip AND a zone-specific time window (zip-scoping NARROWS hours, not just routes — e.g. RI4REG no-zip 1–6:30pm but zip 02904 only 1–2pm). So **always use zip-scoped availability for a normal move**; NO zip = owner-override (all routes, full hours). Invalid zip → silently all routes (must validate zip maps to ≥1 route). **0 slots for a valid zip = no openings THAT DAY → offer another day; NOT out-of-territory** (#90 covers all RI + SE-MA; proven by owner editing the Sat template → 02816 went 0→2 slots live). Zoning + hours are day-dependent.
- **Slot hold (optional):** lock = availability method `2` (`dayID,routeID,zip,serviceTypeID,duration,startTime`) → `Ids.lockID`; validate method `6`; release method `3`. Transient booking-concurrency hold.
- **Cancel a job:** `/data/Jobs` method `4` with Fields **974** (person/category optionID), **975** (reason optionID), **973** (comments text). Status (984→Cancelled 9942), timestamp (977), `cancelledBy` are auto-set. Cancel is a SOFT status change — the job persists (readable by objectID; `isActive=false`). Standard read (method 1) of a cancelled job errors -2012.
- **Job duration field for fit:** use the job's own field 186 when querying availability so only slots the job FITS into are offered.

## Architecture
```
PWA mic (Web Speech) → transcript
  → edge fn `crewlogic-dispatch`: a Claude TOOL-USING agent (server-side, franchise Vonigo creds never leave server)
     tools: listRouteJobs, resolveJob, suggestMoveSlots, cancelReasonCodes, cancelJob, moveJob
  → agent disambiguates via read tools, asks Owner only what it can't infer
  → agent proposes resolved action → Owner CONFIRMS (voice/tap) → agent executes write → reads back result + writes audit row
```
Model: a capable tier (Sonnet+; reason/route codes are identifier-grade — no fabrication). Runs as a multi-turn tool loop.

## Flow A — Cancel
1. Parse → identify job (route + stop#/time, or explicit jobID) on the stated/!default day.
2. `resolveJob` → Vonigo jobID (disambiguate if multiple; confirm client+time back).
3. Collect required cancel inputs: **category (974)** + **reason (975)** [+ optional comments 973]. Map spoken reason → optionIDs from the picklist (see Open Items). Ask if not stated.
4. **Confirm:** "Cancel Mary Cappiello's 9 AM Route 1 job — reason: Customer not ready — yes?"
5. Execute `/data/Jobs` method 4 → read back status.

## Flow B — Move
1. Parse → identify source job (as above) + target (day, time, optional route).
2. Pre-work (the zoning step): get job's service zip → `suggestMoveSlots` = `/resources/availability` for the **target day** with `zip` + the job's **duration (186)** → zoned route(s) + open slots. (Owner override: omit zip → all routes.)
3. Reconcile request vs availability: if the requested slot is open → propose it; if closed/taken → offer nearest open alternatives; if 0 slots that day → tell Owner the route has no openings that day and offer another day (do NOT say "unserved" — #90 covers all RI + SE-MA).
4. (Optional) acquire a **lock** on the chosen slot to hold it through confirmation.
5. **Confirm** the resolved route + day + time.
6. Execute the appointment move — **WorkOrder edit (method 2)** rewriting date (185)/time (9082)/route relation. *(WRITE PATH TO VALIDATE — see Open Items.)* Release lock; read back.

## Open items to validate before/during build
- **MOVE write path:** confirm editing the WorkOrder appointment (date/time/route) via method 2 actually reschedules (the edit pattern is proven on Jobs field 978; not yet on WO appointment fields). One read-only-then-careful-write spike on the cleared **RE-SCD** route.
- **Full cancel picklist:** enumerate field 974 categories (Customer Initiated / Pricing / Scheduling) + field 975 reason optionIDs per category (only Scheduling→"Customer not ready" 10133/10129 captured so far).
- **Client Contact field:** UI marks it required on cancel; appears to map to the client relation — confirm whether method 4 needs it explicitly.
- **Job addressing grammar:** stop-number vs time vs client-name vs jobID; default day = today unless stated.

## Safety / guardrails
- Writes hit the ONE real production Vonigo (no sandbox) → **always-confirm** + **audit log** of every AI action (command, resolved IDs, fields written, result) + a **dry-run** mode for testing.
- Voice/NLU errors absorbed by disambiguation + read-back confirmation.
- Never auto-execute from a single parse; never fabricate reason/route codes.

## Phasing
- **P0 spike:** validate the MOVE write on RE-SCD; pull full cancel picklist.
- **P1:** edge fn `crewlogic-dispatch` (tool agent) + cancel flow end-to-end (confirm + audit + dry-run).
- **P2:** move flow (zoning suggest + lock + WO edit).
- **P3:** PWA mic UI + read-back; owner-override toggle.

## Related
- Memory `vonigo-routes-availability-api` (the full API map this plan builds on).
- `.HUB/Hub.md` "Reschedule a job's appointment from inside CrewLogic" backlog row (this plan supersedes/expands it).
- `eastern-epoch-conversion-discipline` (all date math is TZ-aware, franchise-local).
