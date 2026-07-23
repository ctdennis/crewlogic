# Crew / route / tips operating model (owner, 2026-07-23)

How crews actually work at #90. Owner's own words, captured so labour-cost and crew features build
against reality rather than inference. Every franchise differs in the details; this is #90.

## Assignment

- Before every shift — the evening before, or the same day — **crews are assigned to routes**.
- **Each crew member is assigned individually**, and classified as **driver** or **lugger**.
- **Rule: at least one driver per route.** (A route with only luggers can't move a truck.)
- **Nearly always two people per truck** for jobs. One-person crews are rare and specific:
  - small curbside jobs light enough for one person, OR
  - **dumping trucks** (disposal runs) — more commonly the one-person case, and a real job type
    in its own right, not a shortfall.

So a lone crew member is NOT automatically an error — but on a normal job it usually is. The
"flag a solo crew" check has to know the job type before crying wolf.

## What moves crew during the day

- **Move a job between routes → crew reassigns AUTOMATICALLY.** When a job is moved from route A to
  route B, Vonigo drops A's crew from that job and adds B's crew. Programmatic, inside Vonigo.
  (This is why job-level crew always reflects the route it currently sits on — matches what we
  observed: every job on a route carried that route's identical crew.)
- **Per-job crew ADD (assist).** Owner can also, job by job, add ANOTHER crew to a single job on
  top of the route crew. Real case: Route 1's crew needs a second truck + two more people who live
  on a DIFFERENT route to come assist. Owner opens that job and adds the other crew, so a tip
  splits **four ways, not two**.
  - This is the "combine to help out" case. It is deliberate and recorded at the JOB level.
  - It means a single job can legitimately carry MORE crew than its route — the assist is additive,
    not a reassignment. The three-trucks-at-Bentley day was almost certainly this.

## Tips + the payroll report (the point of all of it)

- At the end of a payroll period the owner runs **two Vonigo reports**:
  1. **tips per lugger**
  2. **tips per work order**
- Payroll is NOT automated from Vonigo (recorded in FW-57): the report is printed and rekeyed by
  hand into each franchise's own payroll system.

## The point of failure — and the real opportunity

> "due to human error, crews didn't get assigned to a job, and it received a tip … prior to
> finalizing we retroactively make sure the crew is assigned and the tip calculates properly."

A tipped job with **no crew** = a tip that pays out to nobody until caught by eye before finalizing.
This is the failure CrewLogic can most usefully attack, and it needs **no write access to do it**:

- **Detect:** any work order with a tip > 0 and **zero crew relations**. Pure read. Surface it days
  before payroll instead of at finalization.
- Optionally also flag: a job with crew but **no driver**; a normal (non-dump) job with a **solo**
  crew; a person on **two routes same day** (status-filtered — a cancelled job's stale crew is not
  a real double-assignment).

Writing crew back to Vonigo would let CrewLogic FIX these, not just flag them — but the detection
alone removes the "found it at finalization" scramble, and detection is read-only and buildable now.

## What this corrects in my earlier reasoning

- "Estimate route correctly has no crew" — WRONG. It was unset because the owner usually doesn't
  bother, not because estimates can't carry crew. Owner assigned himself and it read fine. Estimate
  visits DO carry a real (crew-of-one) labour cost.
- "Three trucks at one job breaks the model" — it's the documented ASSIST case, not chaos. The model
  is 1 route = 1 truck = 1 crew; assists are additive exceptions, and they are visible precisely
  because there is a baseline to compare against.
- Truck→route is NOT derivable from crew (Truck 1 served two routes in one day). The missing link is
  **route→truck** (one value per route per day), which the geofences can PROPOSE from which truck's
  job-arrivals match the route's jobs, for the owner to confirm.

## Where a build would start (not yet approved)

1. **Read-only tip-without-crew detector** — highest value, zero risk, no Vonigo write. Attacks the
   named point of failure directly.
2. **Per-job labour cost** — crew (headcount + driver/lugger) from the WO relation × geofence
   on-site + travel minutes. Measured, not assumed. Filter cancelled; count the assist crew on
   multi-crew jobs.
3. **route→truck link** — the one new piece of data; geofence-proposed, owner-confirmed. Unlocks
   per-truck attribution and makes the assist case explicit ("MA1REG crew + 2 assisting from RI4REG").
4. **Crew write-back to Vonigo** — biggest, riskiest (replace-set could clear crew); would let
   CrewLogic FIX the tip-without-crew case, not just flag it. Bounded because payroll is manual.

Source of truth for crew stays **Vonigo** (it owns tips). Do not duplicate crew into Motive — that
creates drift. If anything writes to Motive, it's the driver-of-record for the truck→person link,
which is a different fact. Motive's `driver` field is currently NULL on all #90 trucks.
