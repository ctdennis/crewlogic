# Leads Booking Contract — Sales Workspace (FW-66)

**Status:** ✅ APPROVED 2026-08-15 (owner). Build authorized. First step: a real throwaway create on #90 to
settle the Job-vs-WO combination, then the `bookLead` edge action + workspace qualify form.
**Scope:** booking a **lead** from the Sales Workspace. Estimate contract is approved (separate doc).
Cancellations / UCB / cases are separate contracts (next). Author: 2026-08-15.

---

## Vonigo semantics (what "book a lead" means)
A lead = a Vonigo **Client** at **stage 123 = "Lead"** (the client record exists; no job yet). Vonigo's
in-app "Book a job from the lead" button has **no supporting API**, so we **create a new job** for that
client. **Endpoint (confirmed):** `POST https://junkluggers.vonigo.com/api/v1/data/Jobs/` `method:"3"` (Add).

**Slot lock (confirmed by owner — SAME spine as estimates).** In the Vonigo UI, double-clicking a calendar
time opens the create form and **locks that 2-hour slot** — everyone else sees it greyed "being booked."
Cancel → the slot frees; proceed → the job drops into it. So a lead booking is: **lock the slot → create the
job into it → release the lock on cancel.** This reuses the estimate contract's availability lock (method 2 →
`lockID`) and release (method 4) primitives — NOT a lock-free create.

## The flow
1. **Qualify** (workspace) — identity prefills from the lead's Client record; manager adds service/job type,
   res-vs-commercial, Customer Situation, item list, campaign source, and **picks a slot**.
2. **Lock the slot** — `/resources/availability/ method:"2"` → `lockID` (slot greys for everyone).
3. **Create the job** — `POST /data/Jobs/ method:"3"` with `clientID` + `Fields` + the locked slot/`lockID`
   → Vonigo creates the scheduled job. Item stage → **Won**.
4. **Release on abort** — if the manager cancels after locking, or the create fails:
   `/resources/availability/ method:"4" {lockID}` → frees the slot. On success the lock is consumed.

---

## Step 1 — QUALIFY (workspace form)
Prefilled from the lead's Client record (read via `/data/Clients/ method:-1`): **last name, email, phone,
address, city, zip**. Manager provides / confirms: **residential vs commercial, Customer Situation, item
list**, the **campaign source**, and the **appointment slot**.

## Step 2 — CREATE (owner supplied TWO create shapes; the WorkOrders one carries the lockID)

**Option A — `POST /data/WorkOrders/ method:"3"`** — creates the scheduled visit and takes the `lockID`
directly. This is the one that puts the appointment in the locked slot:
```
{ securityToken, method:"3", lockID, clientID, contactID, locationID, serviceTypeID:"11",
  Fields:[ {fieldID:"200", fieldValue:"<description>"}, {fieldID:"186", fieldValue:"<durationMin>"},
           {fieldID:"201", optionID:"<label>"}, {fieldID:"10013", fieldValue:""} ] }
```

**Option B — `POST /data/Jobs/ method:"3"`** — creates the job container carrying the campaign/promo/type:
```
{ securityToken, method:"3", clientID, Fields:[ {fieldID:982,optionID:<serviceType>},
  {fieldID:983,optionID:<res/comm?>}, {fieldID:968,fieldValue:"<promo>"}, {fieldID:969,optionID:<campaign>},
  {fieldID:978,fieldValue:"<summary>"} ] }
```

**Field map — AUTHORITATIVE** (from Vonigo `/system/objects/ method:1` field+option metadata; object **7 =
Client, 10 = Job, 12 = WorkOrder**):

| Field | Object | Meaning | Value / source | Status |
|---|---|---|---|---|
| `clientID` | — | the lead | Client id (`pipeline_items.source_external_id`) | ✅ |
| `contactID` / `locationID` | WO | who / where | read from the lead's Client | ✅ |
| `serviceTypeID` `11` | WO | Junk Removal | constant | ✅ |
| `lockID` | WO | held slot | availability lock (method 2) | ✅ |
| **200** | WO | Description | manager (Customer Situation / notes) | ✅ |
| **186** | WO | Duration (mins) | zone default | ✅ |
| **201** | WO | Appointment label | booking label optionID | ✅ |
| **10336** | WO | **Item(s) List** — the ONE required custom WO field | manager | ✅ (this is "item list") |
| **10013** | WO | not in the Junk-Removal WO field set (empty in sample) | — | ignore (n/a for svc 11) |
| **982** | Job | Service Type | **Junk Removal = 10004** | ✅ |
| **983** | Job | **Label** (status label — NOT res/comm) | booking label optionID | ✅ |
| **969** | Job | Marketing Campaign | live `campaigns` list / lead | ✅ |
| **968** | Job | Promotion (promo code) | manager (optional) | ✅ |
| **978** | Job | Summary | derived | ✅ |
| **121** | **Client** | **Type = residential/commercial** | **Residential = 59, Commercial = 60** | ✅ (on Client, not Job) |
| name / email / phone / address / city / zip | Client | identity | already on the lead's Client (via `clientID`) | ✅ (not re-sent) |

Notes: the **Job (obj 10) has no required fields**; the **required create inputs live on the Client**
(Phone 112, Type 121, Status 122, Stage 123, Name 126) — all already set on an existing lead — and the **one
required WO field is 10336 Item(s) List**. Residential/commercial is the **Client's Type (121)**, set on the
lead (or set at book time if blank).

**Open build decision (only one left):** does the **WorkOrders create (A) alone** also create the parent Job
(so 982/969/etc. attach to it), or do we **create the Job (B) then the WO (A)**? Both shapes were supplied.
Resolve with ONE throwaway dev create on #90 at build start (then cancel it) — the create response shows what
got made and which fields stuck. Every fieldID/optionID above is now confirmed from Vonigo metadata.

## Campaign source — RESOLVED
- **Authoritative list:** new read action **`campaigns`** in `crewlogic-dispatch` → Vonigo
  **`/resources/campaigns/`**. Returns `{optionID, name, onlineLabel}` — verified **67 rows for #90**,
  matching the Vonigo UI dropdown exactly (e.g. `16059 Repeat Customer`, `20780 National Account`,
  `16040 Yard Sign`).
- **Scoped to the login, not a param.** The endpoint returns the list for **whichever franchise's Vonigo
  creds you log in with** (a `franchiseID` query param is ignored). So the design is inherently
  per-franchise-correct **without any assumption about whether the list is company-wide or customized**:
  the `campaigns` action logs in with the **booking franchise's own creds** → always that franchise's real
  list. No hardcoding.
  - *(Note: I could not compare #31 vs #90 from **dev** — dev only holds #90's Vonigo creds, so I can't log
    in as #31 there. It's moot by design, per above. A definitive #31-vs-#90 diff would need a read-only
    check against **prod**, which holds all franchise creds — available on request but not required to
    build.)*
- **Selection rule:** default to the **lead's existing 969 optionID** *only if it is present in the live
  `campaigns` set* (legacy/retired optionIDs exist on old records — e.g. a job-scan found `10665`/`20811`
  no longer in the current list). Otherwise the manager **picks from the live list**. Never post a stale
  optionID.

## Inputs & where each comes from
| Field | Source |
|---|---|
| `clientID` | the lead (Vonigo Client id = `pipeline_items.source_external_id`) |
| identity fields | the lead's Client record (`/data/Clients/`) |
| `serviceTypeID` | `11` (Junk Removal) |
| `duration` | the **zone's** service duration (zip → zone → duration) — Vonigo defaults it; we can send it |
| day / time / route | the chosen slot (availability listing, reused from `suggestSlots`) |
| campaign `optionID` | live `campaigns` list (lead's value if still valid) |

## Duration — RESOLVED (live from Vonigo per zip)
**Source: `POST /resources/zips/ {method:"1", zip:"<zip>"}`** → returns the zip's zone config incl.
**`ServiceTypes[].duration`** = the zone's default appointment length. Verified 02347 → `duration: 90`
(zoneID 420 "Local Zone", territoryID 274, priceID 1610). **Use this value** for BOTH the availability lock
(method 2) and WO Field 186 — no hardcoding, no CrewLogic-stored map.
- **Quirk (owner-confirmed):** the row is returned under **serviceType 27 (National Accounts)**, but that
  **same duration applies to Junk Removal (11)** — take `ServiceTypes[0].duration` regardless of the
  serviceType it's listed under. **The `serviceTypeID` request param is IGNORED** (passing 11 vs 27 vs none
  all return the identical single type-27 row for 02347) — so don't try to filter to JR; just read the row
  returned. *(If a franchise ever configures JR ≠ NA durations, add a CrewLogic per-zone override; otherwise
  the zip-lookup value is authoritative.)*
- **Bonus — this ONE call also resolves, per zip:** `zoneID`, `territoryID`, **`priceID` (price list)**, and
  the **provinceOptionID / countryOptionID** for address fields — all useful inputs to the create.
- The qualify form still shows the duration (pre-filled to this value) so the manager can override for an
  unusually large/small job. *(This replaces the hardcoded 120 that caused the 2026-08-15 test disconnect.)*

## Caveats / handling
- **Lock spine (SAME as estimates):** lock the slot (`/resources/availability` method 2 → `lockID`) → create
  (WorkOrders method 3 with that `lockID`) → **release** (`/resources/availability` method 4 + `lockID`) on
  any cancel/failure. On success the lock is consumed. This is the greyed-slot behavior the owner described.
- **Legacy campaign optionIDs:** validate the lead's 969 against the live list before reuse (above).
- **Irreversible in Vonigo:** a create makes a real scheduled job — the dev build must be tested by booking
  a **throwaway lead on #90** and then cancelling it, before anyone books a live one.
- **Client dedup:** we reuse the lead's existing `clientID` (no new client) — avoids duplicate customers.

## Reuse vs. new
- **Reuse (exists):** `/data/Clients/` read, availability **lock (method 2) + release (method 4)** and the
  slot listing (`suggestSlots`) — all from the estimate contract; zip→zone→duration.
- **New:**
  1. **`campaigns`** read action (`/resources/campaigns/`) — the campaign-source dropdown (verified working).
  2. **`bookLead`** write action — `[read lead (client/contact/location) → lock slot → create WO (method 3)
     with lockID + Fields; release lock on any failure/cancel]`, franchise-scoped + audited.
  3. Workspace **qualify form** (identity prefill + service/res-comm + Customer Situation + item list +
     campaign dropdown + slot picker) wired to `bookLead` → Won.

## RESOLVED — verified by a real test create on #90 (2026-08-15)
Test: booked Charles Dennis (client 984250), Aug 19 @ 1:00 PM, route 2983, via `WorkOrders method:3` alone.
Result — **Job 878291 + Appointment "878291-1" created in one call** (`countJobs:1, countWorkOrders:1`),
status Open, correct date/route/client. Findings:
- **The `WorkOrders method:3` create ALONE auto-creates the parent Job** — no separate Jobs-create needed.
  Inputs used: `lockID, clientID, contactID, locationID, serviceTypeID:11` + WO Fields (200 desc, 186 dur,
  10336 item list). The lock (availability method 2) → `lockID` → WO-create → done.
- **`clientID` search/reuse works** (`/data/Clients/ method:0 searchPar` + `isCompleteObject` → the client's
  `contact`/`location` Relations give `contactID`/`locationID`). Reuse the existing client — no dup.
- **Campaign (969) + Service Type (982) auto-default from the client** (an existing customer defaulted to
  "Repeat Customer" / "Junk Removal") — we did NOT send them and they populated. **⚠ For the real `bookLead`,
  SET 969 explicitly** (Jobs-edit method 2 on the returned jobID, or include a Jobs-create) so a lead's
  chosen campaign isn't left to Vonigo's default. Service type 982 → set to Junk Removal (10004) explicitly too.
- ~~983 = res/comm?~~ → **983 = Label**; res/comm = **Client Type (121)**, 59/60. ~~10013~~ → n/a for svc 11.
- Appointment label defaulted to **9984 (New Appointment)** on the WO (201) — good default.

**So the real `bookLead` = [reuse/find client → lock slot → WorkOrders method:3 create → Jobs-edit to set
969 campaign (+982) → release lock on abort].**

## Build sequence (on sign-off)
1. Edge `campaigns` read action (dev) — trivial, already verified.
2. **Throwaway dev create on #90** to nail the Job-vs-WO combination + confirm 983/10013, then cancel it.
3. Edge `bookLead` write action (read lead → lock → create WO with lockID + Fields; release on abort),
   franchise-scoped + audited, dev.
4. Client: workspace **qualify form** for leads → slot picker → confirm → `bookLead` → Won.
5. Verify on dev #90 with a throwaway lead (real Vonigo create), then cancel it, before promotion.

## Contact-record backend (the remaining build) — field maps discovered 2026-08-16

To let ANY lead book (leads usually have a Location object but a sparse/blank address, or the manager needs
to correct it), `bookLead` must **update the client's Contact + Location from the modal fields BEFORE booking**
(the WO create references the `locationID`, so the location must be right first). Real Vonigo writes — GATED.

**Contact** (`POST /data/Contacts/ method:2 objectID:<contactID>`; `isCanEdit:true`):
| Field | ID |
|---|---|
| Phone | **1088** |
| Email | **97** |
| First name | **127** · Last name **128** (display 9795 likely derived — don't rely on editing it) |

**Location** (`POST /data/Locations/ method:2 objectID:<locationID>`; `isCanEdit:true`):
| Field | ID | Note |
|---|---|---|
| Street address | **773** | line 2 = 774 |
| Zip | **775** | |
| City | **776** | |
| State | **778** | a **select — needs optionID**, not text |
| Country | **779** | select optionID (US = 9906) |

**State/country optionIDs come from the zip lookup** (`/resources/zips/ method:1` → `Zip.provinceOptionID`,
`Zip.countryOptionID`, `Zip.defaultCity`) — the SAME call already used for duration. So one zip lookup yields
duration + province/country optionIDs + city. (Text fields like street/city/zip take plain values; state is
the only select.)

**Flow:** resolve client → contactID + locationID → zip lookup (duration + province/country optionIDs) →
**update Contact (97/1088) + Location (773/776/775/778/779)** from modal fields → lock slot → create WO →
deactivate lead. For a lead with NO location relation at all, CREATE the Location/Contact (method 3) first —
a smaller follow-up (most leads already have the objects, just sparse).

**Gotcha:** `/data/Locations/ method:0 objectID:<id>` retrieval is unreliable (returned a different location
than requested — the same wrong-record quirk seen on WOs); trust the client's `location` relation id for the
UPDATE target, don't round-trip-verify by re-retrieving that id.

**⚠ Booking auto-sends a Vonigo appointment confirmation to the customer** — test ONLY on a throwaway/old lead
with the address+email changed to your own (owner 2026-08-16). See the memory `vonigo-booking-sends-confirmation`.

---
*No code until this contract is signed off. Cancellation contract is next.*
