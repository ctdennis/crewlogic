# Vonigo API — working notes + the schema-discovery strategy

Consolidated learnings about the Vonigo API, so we stop re-discovering the same facts. Owner
2026-07-23 flagged the strategic idea at the bottom; the rest is what we've confirmed by probing.

Base: `https://junkluggers.vonigo.com/api/v1`. Auth: MD5 login → `securityToken`, passed in every
body. Full endpoint index is behind Vonigo's own login at `/api/v1/test/` (not fetchable
unauthenticated — owner has sent specific pages as screenshots).

## THE STRATEGY (owner, 2026-07-23) — stop guessing, read the schema

Nearly every Vonigo dead-end this session was a **schema-discovery** problem: not knowing what a
field ID means, not having option codes to write, not knowing object-type codes. The **System**
endpoints are the schema, and the **Multiple Get** call is the batching layer. Together they could
make the integration self-describing and end the screenshot dependency.

System endpoints (from the API index, NOT yet exercised):
- **Get system objects** → object-TYPE codes (the unlabeled `12`/`13` a Multiple list entry needs)
- **Get system fields** → fieldID → name (would resolve "is field 166 the role?" by reading a label)
- **Get system fields for given service type / client type** → context-specific field sets
- **Get system field's options** → optionID → label (the WRITE codes: driver/lugger, promo add, …)
- **Get system field's types** → field data type (text vs dropdown — proves which fields are safe
  to automate; owner noted 166 is free text, which is why automation on it is flaky)
- **Get External Page Labels** → user-facing label strings

**When we build this:** pull the System maps once, cache them (they change rarely), and every
future Vonigo feature reads field/option/type by NAME instead of a hard-coded ID inferred from
contents. NEEDED FIRST — the System endpoint doc pages (path + params + method), same as we did for
promos/users. Do NOT blind-probe for them; the whole point is to stop guessing.

## Multiple Get — `/data/Multiple/`  (tested 2026-07-23)

Batches multiple **LIST** queries into one HTTP call. Each `Lists[]` entry carries list params
(dateStart/dateEnd/dateMode/pageSize/pageNo/sortMode/sortDirection) + a `Fields[]` request + an
`objectID` that is the object-TYPE code, NOT a record ID.

- Confirmed: a by-record-ID shape (`{objectID: '3387', Fields:[{166}]}`) returns `errNo 0` but an
  EMPTY `Multiple` array — it does not fetch individual records by ID.
- So Multiple is for batching list retrievals (e.g. WorkOrders list + Users list in one call), and
  needs the object-type codes from **Get system objects** to target the right lists.
- Latency note: it is NOT worth adopting for the crew-title lookups. Those already run in parallel
  (`Promise.all`), so wall-clock is ~1 round-trip regardless of crew size. Multiple's only win there
  is request COUNT (rate-limit friendliness), which doesn't matter at ~6-8 crew. Revisit only for
  large-scale batch reads (e.g. a multi-day crew/tips report).

## Method enum — NOT uniform across object types

Documented per-endpoint. Seen so far:
- Most objects: **Retrieval = 1, Edit = 2, Add = 3** (promos, users, work orders, jobs)
- List reads often use **method `-1`** (routes, users list, jobs `-1`) and sometimes **`0`**
  (availability). `/resources/promos/` needs **`-1`** to list all (method 1 requires a promo code).
- `/data/priceLists/` documents **Edit = 2 / Add = 3** — same numbers, but do not assume `4` = edit
  everywhere; WorkOrder edit is method **`4`**, WorkOrder MOVE is method **`16` + a lockID**.
  ALWAYS confirm the method for a given endpoint before a write.

## Confirmed field / object facts

- **Crew** is a **Relation** on the WorkOrder (`relationType:'crew'`, objectID = the user's ID,
  name). It carries NO role — just id/name/isActive. There is no `/resources/crews/` endpoint;
  crew members are **Users**.
- **Field 166 on a User = "Job Title"** — FREE TEXT, one value per person (the PROFILE title). Not
  per-route, not per-day. It drifted stale for years (Carter read "Lugger" long after he started
  driving), so it is shown raw and never used as logic. Fields 167 (opt 141) and 168 (=name) sit
  beside it; 168 is the display name.
- **Per-route-per-day role (driver/lugger, green/brown in Vonigo's route view)** is a SEPARATE
  object behind the route's "View Assignment" — endpoint NOT yet located. This, not field 166, is
  the authoritative daily role.
- **Position** (under "Franchise Specific Data" in the UI) is NOT returned by `/resources/users/`
  at all (global or franchise-scoped) — a different sub-object.
- `/resources/users/` list view is THIN (userID/userName/gmtOffsetUser/isActive) and IGNORES a
  `Fields` request — field 166 only appears on the single-record `method:1` detail. This is exactly
  the limitation the System+Multiple approach would work around.
- **Users total ~6,799** system-wide; the users list is NOT franchise-scoped by a `franchiseID`
  param (returned all 6,799 regardless). "Get the list of users for given franchise" is a distinct
  endpoint we have not exercised.

## Cross-refs
- `docs/crew-operating-model.md` — how crews/routes/tips actually work at #90
- `docs/vonigo-mark-complete-findings.md` — the mark-complete write contract (FW-54)
- `.HUB/Hub.md` FW-54 (mark complete), FW-57 (crew assignment + labour cost)
