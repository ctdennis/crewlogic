# Marking a job/appointment complete from CrewLogic — Vonigo write contract

**Status:** BLOCKED on a fresh test subject. Read side fully understood; write side unverified.
**Owner:** Charles Dennis
**Next action:** when a new estimate appointment is booked, run the write test in §5 BEFORE it is
completed in Vonigo by hand.
**Tracker:** `.HUB/Hub.md` → FW-54.

Goal: click a job in CrewLogic and mark it complete, instead of going into Vonigo to do it.

---

## 1. What was measured

2026-07-21, live prod Vonigo, real customer record:

- Job **868145** — Bentley, Carolyn, 70 Overlook Drive, Raynham
- **One Job, TWO appointments** (`apptCount: 2`), each its own WorkOrder:

| Appointment | WO | Route | When | Status before | Label |
|---|---|---|---|---|---|
| **Estimate** | **999978** | MA3ALL (R3) | 2026-07-21 12:00 PM | `Open - Booked Today` / **161** | 245 |
| Job | 1000061 | MA1REG | 2026-07-22 8:00 AM | `Open` / 160 | 9975 |

Owner completed the ESTIMATE appointment (WO 999978) in the Vonigo UI. Raw WorkOrder captured
immediately before and after via `crewlogic-dispatch` `action: 'rawObjects'` (read-only).

## 2. Result — exactly two fields changed, out of 50

```
field 181  (status)
   before  'Open - Booked Today'   optionID=161
   after   'Service Complete'      optionID=164

field 8700 (completed-at timestamp)
   before  ''
   after   '2026-07-21T17:01:00'
```

**Relations unchanged. Nothing else moved** — no payment fields, no label change (201 stayed 245),
and the two estimate-marker fields (9920 `true`, 9949 optionID 22599) were untouched.

So the write is almost certainly a single field: **181 → optionID 164**.

## 3. Two findings that are not obvious

**"Complete" has two destinations.** Every finished JOB on 2026-07-21 sits at **165 Archived**,
while this ESTIMATE went to **164 Service Complete**. Consistent with the earlier finding that #90's
geofence tracking ends on PAYMENT (status 165). An estimate carries no money — the estimate WO has
no price field at all, while the job WO has 639.00 — so it stops at 164. Any "mark complete" UI must
not assume one target status.

**Vonigo mixes time conventions across fields on the SAME object.** Field 185 (appointment date) uses
the naive-Eastern epoch convention documented in CLAUDE.md. Field 8700 came back as
`2026-07-21T17:01:00` when the capture landed at `17:01:43Z` — i.e. **UTC**. If Vonigo populates 8700
itself we never touch it; if it does not, writing a naive-Eastern value there would stamp a
completion time four hours out.

## 4. Why this is blocked

**Completion is irreversible in Vonigo** (owner, 2026-07-21): once an appointment completes it
cannot be un-completed. So WO 999978 cannot be reset to 161 and re-completed through the API, and no
already-completed record can serve as a test subject.

The write test needs a **fresh estimate appointment that has not yet been completed by hand**.

## 5. The test to run next — before completing it manually

1. Identify the new estimate appointment:
   `crewlogic-dispatch` `{action:'listRouteJobs', franchiseID:'90', dayID:'<YYYYMMDD>'}`
   → find the row whose `labelOpt` is 245 / status 161, and note **woID** and **jobID**.
2. Capture the raw before:
   `{action:'rawObjects', franchiseID:'90', jobID:'<jobID>', dayID:'<YYYYMMDD>'}`
   (scopes by date, so it returns the right WO when a job has two appointments).
3. Attempt the write against `/data/WorkOrders/`:
   ```
   { method: '<see below>', objectID: '<woID>', Fields: [ { fieldID: 181, optionID: '164' } ] }
   ```
4. Capture the raw after and diff. Confirm 181 moved AND whether **8700 populated by itself**.

**The one unknown the diff could not answer: the method code, and whether a lock is required.**
Known Vonigo write patterns in this codebase:

- `crewlogic-dispatch` cancel → `/data/Jobs/` with **`method: '4'`** (edit) + Fields 974/975
- `crewlogic-dispatch` move → `/data/WorkOrders/` with **`method: '16'` AND a `lockID`** obtained
  from a preceding lock call

So WorkOrder edits may require the lock step that Job edits do not. Try `method: '4'` first; if
Vonigo returns an errNo, inspect whether it demands a lock and reuse the move path's lock helper.
Note also that `/data/priceLists/` documents Edit=**2**/Add=**3** — method numbering is not uniform
across Vonigo object types, so do not assume 4 means edit everywhere.

## 6. Capture tool

`crewlogic-dispatch` `action: 'rawObjects'` — read-only (list + `method: '-1'` reads). Returns the
raw WorkOrder and Job for one job, scoped by dayID so it picks the right appointment when a job has
several. Added 2026-07-21 for this investigation and RETAINED, because the next test needs it.

Baselines from this session are in the session scratchpad (`bentley-est-before.json` /
`bentley-est-after.json`); they are ephemeral, but §2 records everything they showed.
