# CrewLogic — CRM Integration Field Inventory

**Purpose:** a single, living map of every field, enum, operation, and concept CrewLogic
needs from a CRM, so we can evaluate/connect a new CRM (Salesforce / ServiceTitan / other)
without missing anything. Vonigo is the reference implementation.

**How to use:** for each row, fill the **SFDC** and **ServiceTitan** columns with the
equivalent field/endpoint (or `NONE` if the CRM has no equivalent — that's a gap to design
around). `_TBD_` = not yet mapped.

**Status legend:** R = CrewLogic reads · W = CrewLogic writes · D = display-only ·
**REQ** = required for a core flow (estimating / quote submit / scheduling).

**Last updated:** 2026-07-03 · derived from a full audit of the 7 Vonigo edge functions +
`index.html` + the Supabase schema. Keep it current when CRM touch-points change.

---

## 0. START HERE — the integration seam

CrewLogic already has a provider-abstraction seam. A new CRM plugs in here:

| Gate (`tenants` column) | Values today | Controls |
|---|---|---|
| `pricing_source` | `vonigo` \| `native` | `native` → `crewlogic-pricing` (local price book); else `crewlogic-price-lookup` (Vonigo) |
| `customer_source` | `vonigo` \| `native` | `native` → local `customers` table search; else Vonigo `searchClients` |
| `submission_target` | `vonigo` \| `none` | `vonigo` → submit quote to Vonigo; `none` → no external submission |

- **No CHECK constraint** on these columns → `salesforce` / `servicetitan` can be added as
  values with **no migration**. Each new value needs new provider branches in the edge functions.
- The **native** path (`customers` table, `price_lists`/`price_list_zips`, `crewlogic-pricing`,
  `crewlogic-signup`) already runs a tenant fully off-Vonigo — it's the template for a new CRM.
- What has **no abstraction yet** (must be built per-CRM): the numeric field-ID/option-ID mapping,
  the Job-vs-WorkOrder model, the quote/charge wire-shape, and the auth model.

**Load-bearing IDs (per session, from `profiles → franchises → tenants`):**
`franchiseID` (= `franchises.external_id`, the Vonigo franchise "90" — sent to every call),
`franchiseInternalID` (UUID), `tenantID`, and the three gates above. A missing external
`franchiseID` silently 404s all CRM lookups.

---

## 1. Connection & Auth

| Aspect | Vonigo | SFDC | ServiceTitan |
|---|---|---|---|
| Host | `junkluggers.vonigo.com/api/v1` (single, hardcoded) | _TBD_ | _TBD_ |
| Auth | `GET /security/login/?company&userName&password={MD5}` → `securityToken` (session token, no refresh; fresh login per call). **NOT OAuth.** | _TBD_ (OAuth2) | _TBD_ (OAuth2 / API key) |
| Per-franchise creds | `vonigo_credentials` (username + Vault-stored MD5), read via `get_vonigo_credential` RPC | _TBD_ | _TBD_ |
| Success convention | `{ errNo, errMsg, ... }`, `errNo===0` = OK; negative = validation error | _TBD_ | _TBD_ |
| Franchise/org key | `franchises.external_id` sent as `franchiseID` for server-side filtering | _TBD_ | _TBD_ |

---

## 2. Entity field tables

### 2.1 Customer / Client
| CrewLogic field | Use | Req | Vonigo source | SFDC | ServiceTitan | Notes |
|---|---|---|---|---|---|---|
| clientID | R/W | **REQ** (submit) | `/data/Clients/` `objectID`; WO `client` relation | _TBD_ | _TBD_ | Primary customer key; carried into quote create |
| clientName | R/W/D | REQ | Client `name` / WO fieldID **183** | _TBD_ | _TBD_ | Editable in estimate |
| client address | R | | Client fieldID **129** | _TBD_ | _TBD_ | search results; zip regex-parsed |
| primary contact (name) | R | | Client fieldID **130** | _TBD_ | _TBD_ | shown in search |
| **searchClients op** | R | REQ | `POST /data/Clients/` `method:0, searchPar, pageSize:20` | _TBD_ | _TBD_ | native tenants use local `customers` |

### 2.2 Contact
| CrewLogic field | Use | Req | Vonigo source | SFDC | ServiceTitan | Notes |
|---|---|---|---|---|---|---|
| contactID | R/W | **REQ** (submit) | WO `contact` relation `objectID` | _TBD_ | _TBD_ | |
| clientEmail | R/D | | Contact fieldID **97** | _TBD_ | _TBD_ | |
| clientPhone | R/D | | Contact fieldID **1088** | _TBD_ | _TBD_ | |

### 2.3 Location / Address
| CrewLogic field | Use | Req | Vonigo source | SFDC | ServiceTitan | Notes |
|---|---|---|---|---|---|---|
| locationID | R/W | **REQ** (submit) | WO `location1` relation `objectID` | _TBD_ | _TBD_ | |
| address (full) | R/W/D | REQ | WO fieldID **184** (multiline → ", ") | _TBD_ | _TBD_ | **One free-text field — no structured city/state/zip** |
| zip | R (derived) | **REQ** (pricing) | regex `\b[A-Z]{2}\s+(\d{5})\b` from 184 | _TBD_ | _TBD_ | drives price list + tax |
| lat / lng | R (external) | | **NOT in Vonigo** — US Census geocoder → `geocode_cache` | _TBD_ | _TBD_ | CRM may supply these directly |

### 2.4 Job / WorkOrder / Appointment  ⚠ Vonigo splits Job (jobID) vs WorkOrder (woID)
| CrewLogic field | Use | Req | Vonigo source | SFDC | ServiceTitan | Notes |
|---|---|---|---|---|---|---|
| jobID | R/D | REQ (attach/cancel) | `job` relation `objectID` | _TBD_ | _TBD_ | logical booking; **cancel target** |
| woID / workOrderID | R/D | REQ (move) | WO `objectID` | _TBD_ | _TBD_ | appointment; **move target** |
| countWorkOrders | R | REQ (safety) | `/data/Jobs/` `countWorkOrders` | _TBD_ | _TBD_ | >1 active appt blocks cancel |
| status | R/D | REQ (gate) | WO fieldID **181** (optionID) | _TBD_ | _TBD_ | see §3 status map |
| label | R/D | | WO fieldID **201** (optionID) | _TBD_ | _TBD_ | see §3 label map (gray/done) |
| date of service | R/D | | WO fieldID **185** (naive-Eastern epoch) | _TBD_ | _TBD_ | |
| time | R/D | | WO fieldID **9082** (min from midnight) | _TBD_ | _TBD_ | 540 = 9 AM |
| duration (min) | R | REQ (move-fit) | WO fieldID **186** | _TBD_ | _TBD_ | set via availability lock, not directly |
| price | R/D | | WO fieldID **813** | _TBD_ | _TBD_ | |
| items (customer) | R/W/D | | WO fieldID **10336** | _TBD_ | _TBD_ | safe to show |
| summary / notes (confidential) | R | | WO fieldID **200** | _TBD_ | _TBD_ | **Job-Plan AI only, never crew/customer** |
| item locations | R/W | | WO fieldID **11215** (multi-checkbox) | _TBD_ | _TBD_ | custom encoding (see §3) |
| route | R/D | REQ (dispatch) | `route` relation | _TBD_ | _TBD_ | |
| zone | R | | `zone` relation `objectID` | _TBD_ | _TBD_ | → price list |
| **Relations** | R | | array: `client, contact, location1, job, route, zone` (stable named types) | _TBD_ | _TBD_ | the one named (not numeric) part of Vonigo |

### 2.5 Estimate / Quote (submission)  `/data/Quotes/`
| CrewLogic field | Use | Req | Vonigo source | SFDC | ServiceTitan | Notes |
|---|---|---|---|---|---|---|
| create quote | W | REQ | method **3**: `{clientID, contactID, locationID, serviceTypeID:11, jobID?, Fields[], Charges[]}` | _TBD_ | _TBD_ | returns `Quote.objectID` = quoteID |
| edit quote | W | | method **2**: option-IDs (dwelling/parking/jobType) + fields | _TBD_ | _TBD_ | |
| delete quote | W | | method **4**: `objectID` | _TBD_ | _TBD_ | |
| vonigoQuoteID | R/W | | quote `objectID` (from create) | _TBD_ | _TBD_ | gates re-submit; deep-link |
| notes | W | | quote fieldID **914** | _TBD_ | _TBD_ | ASCII-only |
| items list | W | | fieldID **10336** | _TBD_ | _TBD_ | |
| item locations | W | | fieldID **11215** | _TBD_ | _TBD_ | |
| charge (line item) | W | REQ | `{priceItemID, taxID, Fields:[9290 name,9289 desc,9288 qty,9287 price]}` | _TBD_ | _TBD_ | field IDs Vonigo-specific |
| photo upload | W | | `/data/documents/` method **3** `{quoteID, fileName, file64BitBase}` | _TBD_ | _TBD_ | base64 JPEG |

### 2.6 Pricing / Price List  `/data/priceLists/`, `/resources/priceLists/`
| CrewLogic field | Use | Req | Vonigo source | SFDC | ServiceTitan | Notes |
|---|---|---|---|---|---|---|
| item lookup | R | **REQ** | `POST /data/priceLists/` methods **2 + 3 merged**, by `zipCode` or `zoneID`, `serviceTypeID:11` | _TBD_ | _TBD_ | |
| priceItemID | R | REQ | price item `objectID` | _TBD_ | _TBD_ | join key → quote charge + tax |
| **taxID** | R | **REQ** | per-item tax schedule | _TBD_ | _TBD_ | **must carry to charge or Vonigo rejects (-7207)** |
| value (unit price) | R | REQ | | _TBD_ | _TBD_ | |
| priceBlockID / name / sequence | R | | grouping (block 560 "Products" excluded) | _TBD_ | _TBD_ | |
| unitOfMeasure, isActive, isQuantifiable, isHourlyPrice, isAllowDecimals | R | | item flags | _TBD_ | _TBD_ | |
| priceListID / name | R/D | | `/resources/priceLists/` (`priceListID`/`priceList`) | _TBD_ | _TBD_ | zip/zone → list mapping is server-side |

### 2.7 Route / Schedule / Availability  `/resources/routes/`, `/resources/availability/`
| CrewLogic field | Use | Req | Vonigo source | SFDC | ServiceTitan | Notes |
|---|---|---|---|---|---|---|
| routes | R | REQ (board) | `/resources/routes/` method **-1** → `routeID, routeName, routeAbbr, sequence, bookingPriority, timeStart, timeEnd, routeStatusID, isActive` | _TBD_ | _TBD_ | board columns + time axis |
| availability / open slots | R | REQ | `/resources/availability/` method **0** → `{dayID, routeID, startTime}` | _TBD_ | _TBD_ | startTime = min from midnight |
| lock slot | W | REQ (move) | method **2** → `lockID` | _TBD_ | _TBD_ | lock's duration sets WO field 186 |
| move appointment | W | | `/data/WorkOrders/` method **16** (`objectID`=woID + `lockID`) | _TBD_ | _TBD_ | |
| cancel job | W | | `/data/Jobs/` method **4** (fields 974/975/973) | _TBD_ | _TBD_ | see §3 cancel reasons |
| dayID | derived | | `YYYYMMDD` → naive-Eastern midnight epoch | _TBD_ | _TBD_ | |

### 2.8 Service Type
| CrewLogic field | Use | Req | Vonigo source | SFDC | ServiceTitan | Notes |
|---|---|---|---|---|---|---|
| serviceTypeID | W | **REQ** | constant **"11" = Junk Removal**, hardcoded everywhere | _TBD_ | _TBD_ | new CRM needs its job/service-type equivalent |

---

## 3. Enum / picklist maps (a new CRM needs an equivalent for each)

**Status — WO fieldID 181** — map each to the new CRM's status:
| Vonigo optionID | Meaning | CrewLogic rule | SFDC | ServiceTitan |
|---|---|---|---|---|
| 160 | Open | keep | _TBD_ | _TBD_ |
| 161 | Open - Booked | keep | _TBD_ | _TBD_ |
| 162 | Cancelled | **filtered out** | _TBD_ | _TBD_ |
| 163 | In Progress / Cancelled-Today (text) | filtered if text `/cancel/i` | _TBD_ | _TBD_ |
| 164 | Completed | keep, render gray | _TBD_ | _TBD_ |
| 165 | Archived | keep, render gray | _TBD_ | _TBD_ |

**Label — WO fieldID 201** — gray/"done" set = **{245, 9996, 9993}**:
| optionID | Meaning | SFDC | ServiceTitan |
|---|---|---|---|
| 245 | Estimate Completed (Job) | _TBD_ | _TBD_ |
| 9996 | Estimate Completed (Est. Only) | _TBD_ | _TBD_ |
| 9993 | Lost | _TBD_ | _TBD_ |
| 9975 / 9970 | Converted (Job / Est-Only) — active until Archived | _TBD_ | _TBD_ |
| 9981 | National Account — active until Archived | _TBD_ | _TBD_ |

**Cancel reasons — Job fields 974 (category) / 975 (reason), independent** (+ 973 free text):
Customer-Initiated (974=10131): keep-items 11335 · removed-self 26317 · duplicate 26319 · no-contact 21343 · no-longer-required 10125.
Pricing (974=10132): thought-we-were-free 26318 · price-concerns 10126 · used-alt-company 26320.
Scheduling (974=10133): not-ready 10129 · date-no-longer-works 10127.
Admin (974=10130): test-booking 12018. → _map to new-CRM cancel reasons (TBD)_

**Item locations — WO fieldID 11215 (multi-checkbox):** 18910 Basement · 18911 1st Floor · 18912 2nd Floor · 18913 3rd Floor · 18914 Attic · 18915 Outside/Garage. Encoding: `optionID!~!Label!` `!{1|0}...` custom serialization.

**Quote option defaults:** jobType 10765=12172 (Multiple Items) · dwelling 10726=11227 (Private Home) · parking 10258=10450 (Driveway).

---

## 4. CRM operations CrewLogic performs (capability checklist)

Mark each ✓ / ✗ / partial for a candidate CRM:
| # | Operation | Vonigo | SFDC | ServiceTitan |
|---|---|---|---|---|
| 1 | Auth / get session | `/security/login/` | _TBD_ | _TBD_ |
| 2 | List jobs for franchise + day | `/data/WorkOrders/` dateMode 3 | _TBD_ | _TBD_ |
| 3 | Look up one job by ID | `/data/WorkOrders/` by jobID | _TBD_ | _TBD_ |
| 4 | Read job (appt count + cancel fields) | `/data/Jobs/` | _TBD_ | _TBD_ |
| 5 | Search clients | `/data/Clients/` method 0 | _TBD_ | _TBD_ |
| 6 | Get client contact (email/phone) | `/data/Contacts/` | _TBD_ | _TBD_ |
| 7 | Price-list items by zip/zone | `/data/priceLists/` 2+3 | _TBD_ | _TBD_ |
| 8 | Price-list display names | `/resources/priceLists/` | _TBD_ | _TBD_ |
| 9 | Routes | `/resources/routes/` -1 | _TBD_ | _TBD_ |
| 10 | Availability / open slots | `/resources/availability/` 0 | _TBD_ | _TBD_ |
| 11 | Create quote | `/data/Quotes/` 3 | _TBD_ | _TBD_ |
| 12 | Edit quote | `/data/Quotes/` 2 | _TBD_ | _TBD_ |
| 13 | Delete quote | `/data/Quotes/` 4 | _TBD_ | _TBD_ |
| 14 | Upload photo to quote | `/data/documents/` 3 | _TBD_ | _TBD_ |
| 15 | Lock/reserve slot | `/resources/availability/` 2 | _TBD_ | _TBD_ |
| 16 | Move appointment | `/data/WorkOrders/` 16 | _TBD_ | _TBD_ |
| 17 | Cancel job | `/data/Jobs/` 4 | _TBD_ | _TBD_ |
| 18 | Change duration | 2-step lock+move (no direct field) | _TBD_ | _TBD_ |

---

## 5. Vonigo-isms / porting risks (design these away for a clean multi-CRM layer)

1. **Magic numeric fieldIDs** everywhere (181/183/184/185/186/200/201/813/9082/10336/11215; 97/1088/129/130; 914/9287-9290/10258/10726/10765). No name abstraction.
2. **Numeric option-IDs** for every picklist (status/label/cancel/dwelling/parking/jobType) — harvested empirically, no enum layer.
3. **Job vs WorkOrder split** — move targets the WO (method 16), cancel targets the Job (method 4); `countWorkOrders` multi-appt safety. SFDC/ServiceTitan model this differently.
4. **Method codes as verbs** — same endpoint, different numeric `method` = different operation. New CRM needs discrete REST verbs / op params.
5. **`serviceTypeID:'11'`** hardcoded (Junk Removal).
6. **Naive-Eastern epoch** date convention (`dateMode:3`, min-from-midnight times, minute durations).
7. **Duration can't be edited directly** — only via a two-step availability lock + move.
8. **`taxID` per line item** (Vonigo tax schedules; wrong ID → whole quote rejected `-7207`).
9. **ASCII-only text** fields (dashes/curly quotes/bullets rejected as "data validation failed").
10. **Non-JSON error bodies** (HTML pages) must be parsed defensively.
11. **Address is one free-text field** — no structured city/state/zip/geo; parsed + geocoded externally.
12. **Single-host, single-tenant, MD5 auth** hardcoded per function.
13. **`customer_price_lists.vonigo_client_id`** column literally names Vonigo; VIP lists keyed to Vonigo client IDs.

---

## 6. Required vs nice-to-have (minimum viable CRM connection)

**Required for core flows:**
- **Pricing:** `franchiseID` + `zip`/`zone` + price book (`priceItemID`, `value`, `taxID`, block name).
- **Quote submit:** `clientID` + `contactID` + `locationID` (all three hard-required) + `charges[]` (`priceItemID` + `taxID`) + `serviceTypeID` + `franchiseID`. `jobID` only for attach mode.
- **Dispatch:** `franchiseID`, `dayID`, `routeID`, `woID`, `startTime`, `durationMin`, `zip`, `serviceTypeID` (move); `jobID` + cancel category/reason (cancel); routes + availability.
- **Session:** `franchiseID` (external) + `franchiseInternalID` + the three `*_source`/`submission_target` gates.

**Nice-to-have / display-only:** clientEmail, clientPhone, price, items, label color, route name, dateService, summary/notes (confidential), itemLocations, zoneName, franchiseName, cover photo, special terms, cost analysis.

---

## 7. Where the code touches the CRM (file map)

- **Edge fns (Vonigo boundary):** `crewlogic-todays-workorders`, `crewlogic-job-lookup`,
  `crewlogic-estimate` (submitQuote/searchClients/save/delete/calcDistances),
  `crewlogic-dispatch` (move/cancel/audit), `crewlogic-price-lookup`, `crewlogic-job-plan`,
  dev `crewlogic-vonigo-probe`. Native equivalents: `crewlogic-pricing`, `crewlogic-signup`.
- **Frontend:** estimate editor + `submitQuote` wire-shape (`index.html` ~16487-16590),
  `lookupEstimateJobStep1` (~15944), `searchVonigoClients` (~5628), `updateClientInfoBar`,
  the dispatch board/`boardGrid`, session build (~5210-5270).
- **Schema:** `estimates` (CRM linkage cols + payload), `estimate_charges`, `franchises.external_id`,
  `tenants.{pricing_source,customer_source,submission_target,crm_type,crm_config}`,
  `customer_price_lists.vonigo_client_id`, `vonigo_credentials` (+ Vault MD5), `job_plans.routes`,
  native `customers` (the non-Vonigo seam).

---

_Maintained as CRM touch-points change. When a new CRM is chosen, fill its column across every
table above; any `NONE` cell is a gap to design a workaround for before committing to that CRM._
