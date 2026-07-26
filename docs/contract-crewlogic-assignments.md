# API Contract — `crewlogic-assignments` edge function

**Status:** DRAFT — awaiting Owner approval (gate 1 of §11 in `docs/plan-truck-route-eta.md`). No schema/migration/code until this is approved.
**Owner:** Charles Dennis
**Related:** `docs/plan-truck-route-eta.md` (FW-59), `docs/contract-jobs-schema.md`, `docs/contract-vonigo-adapter.md`.

---

## 1. Shape & conventions

- **Endpoint:** `POST /functions/v1/crewlogic-assignments`
- **Auth model:** same as `crewlogic-jobs` — the app calls with the anon key; the function uses the **service role** internally and scopes every query by the caller-supplied `franchiseInternalID` (never a direct RLS read — the token-expiry lesson). No JWT/RLS dependence.
- **Request body:** JSON `{ action, franchiseInternalID, ... }`. `action` selects the operation (below).
- **Time zone:** all dates resolve in the franchise TZ via `_shared/tz.ts` (`ymdInTz`). `serviceDate` is a franchise-local `YYYY-MM-DD`; omit to default to "today" in that TZ.
- **Truck identity:** `truckKey` matches `franchise_trucks.truck_key` (`vin:<VIN>` or `name:<name>`).

### Error envelope (per no-internals-to-client + never-suppress rules)
Client body on any error: `{ "error": <label>, "code": <stable code>, "message": <short safe text> }`. Full error + stack is `console.error`-logged server-side, never returned.

| HTTP | `code` | When |
|---|---|---|
| 400 | `bad_request` | missing/invalid params |
| 404 | `not_found` | unknown franchise / route / date has no board |
| 502 | `upstream` | Vonigo or Distance Matrix failure |
| 500 | `server_error` | unexpected |

Enum — assignment `source`: `manual` (hard set) · `default` (pre-filled from prior day) · `inferred` (geofence auto-set).
Enum — job/route ETA `status`: `within` · `early` · `late` · `pending` (not yet predictable) · `done`.

---

## 2. `action: "get"` — board dropdowns + current assignments

**Request**
```json
{ "action": "get", "franchiseInternalID": "uuid", "serviceDate": "2026-07-26" }
```
`serviceDate` optional (defaults to today, franchise TZ).

**Response 200**
```json
{
  "serviceDate": "2026-07-26",
  "trucks": [
    { "truckKey": "name:Truck 3", "name": "Truck 3", "number": 3, "active": true, "status": "moving" }
  ],
  "routes": [
    { "vonigoRouteId": "5982", "routeName": "Route 3 (MA3ALL)",
      "assignment": { "truckKey": "name:Truck 3", "source": "manual", "assignedBy": "charles.dennis@junkluggers.com", "updatedAt": "2026-07-26T11:02:00Z" } }
  ]
}
```
- `trucks` = the franchise roster (`franchise_trucks`, active first); `status` = live telematics state (`moving`/`parked`/`stale`/`offline`/`unknown`) for the live dot.
- `routes` = today's routes from the dispatch board; `assignment` is `null` when nothing is set yet. A route with no row but a prior-day assignment returns that as `source: "default"` (pre-fill).

---

## 3. `action: "set"` — hard-set / clear one route's truck

**Request**
```json
{ "action": "set", "franchiseInternalID": "uuid", "serviceDate": "2026-07-26",
  "vonigoRouteId": "5982", "routeName": "Route 3 (MA3ALL)",
  "truckKey": "name:Truck 3", "assignedBy": "charles.dennis@junkluggers.com" }
```
- `truckKey: null` **clears** the assignment for that route+date.
- Upserts one `route_truck_assignments` row, `source: "manual"`.

**Response 200**
```json
{ "ok": true, "assignment": { "vonigoRouteId": "5982", "truckKey": "name:Truck 3", "source": "manual", "updatedAt": "2026-07-26T11:02:00Z" } }
```

---

## 4. `action: "eta"` — the prediction engine (both modes, §6)

**Request**
```json
{ "action": "eta", "franchiseInternalID": "uuid", "serviceDate": "2026-07-26",
  "mode": "auto", "durationMultiplier": 1.0 }
```
- `mode`: `"auto"` (default — day-start before roll-out, live once trucks move), `"daystart"`, or `"live"`.
- `durationMultiplier`: day-start only, `0.6`–`1.4`, default `1.0` (the ops dial). Ignored in live mode.
- `serviceDate`: **any** date — *past* (review a day that already ran), *today*, or *future* (preview how an upcoming day will play out). A future date forces day-start mode.
- `origin`: the day-start start point for **every** route — `"yard"` (default: the franchise's truck-base address = the existing `cost_settings.officeAddress`, geocoded — for #90 the **parking** address *2 County Road*, not the office-of-record) or `{ "lat": n, "lon": n }` to override. This is why day-start starts all trucks from a fixed base, not live GPS. Live mode ignores `origin` (each truck uses its own live position).

**Response 200**
```json
{
  "serviceDate": "2026-07-26",
  "mode": "live",
  "routes": [
    {
      "vonigoRouteId": "5982", "routeName": "Route 3 (MA3ALL)",
      "truckKey": "name:Truck 3", "truckStatus": "moving",
      "rollup": { "status": "late", "minutes": 18 },
      "jobs": [
        {
          "woId": "12345", "jobNo": "12345", "customerName": "Helen DiSilvia",
          "town": "Norwalk", "phone": "+12035551212",
          "lat": 41.11, "lon": -73.42,
          "windowStart": "2026-07-26T10:00:00Z", "windowEnd": "2026-07-26T12:00:00Z",
          "predictedEta": "2026-07-26T10:42:00Z",
          "status": "within", "minutesEarlyLate": 0,
          "statement": "We anticipate Truck 3 to arrive at Job #12345 for Helen DiSilvia in Norwalk at 10:42 AM. This is within the scheduled appointment window.",
          "vonigoUrl": "https://.../workorder/12345"
        }
      ]
    }
  ]
}
```
- `rollup` = worst remaining stop on the route (drives the board chip).
- `window*` = `[timeMin, timeMin + durationMin]` (§7). `statement` is the pre-rendered §1 sentence; when `status` is `late`/`early` it appends the minutes and (outside only) the "please contact customer at …" line. `phone` (E.164, for `tel:`) and `vonigoUrl` support the clickable popup.
- Day-start mode is **truck-agnostic** — the feasibility walk is a property of the route (its jobs, windows, and geography from the parking origin), so it runs **with or without a truck assignment**. That's what makes future-date previews work: point `eta` at tomorrow's `serviceDate` and read each job's `predictedEta` + `status` to see how the day plays out. For an unassigned/future date, `truckKey`/`truckStatus` come back `null`. **Caveat:** a future board reflects only jobs booked **so far** (jobs keep booking up to same-day — ~30–40% land within 24h), so a preview firms up as the date approaches. Response carries `"mode": "daystart"` and each route a `"guesstimate": true` flag.

---

## 5. `action: "check"` — first-arrival mismatch / auto-set (§5)

Called on a geofence arrival event (or polled). For each route with a first `job_arrive` today:

**Request**
```json
{ "action": "check", "franchiseInternalID": "uuid", "serviceDate": "2026-07-26" }
```

**Response 200**
```json
{
  "serviceDate": "2026-07-26",
  "results": [
    { "vonigoRouteId": "5982", "routeName": "Route 3 (MA3ALL)",
      "arrivedTruckKey": "name:Truck 1", "assignedTruckKey": "name:Truck 3",
      "outcome": "mismatch", "warning": "Truck 1 arrived first on Route 3, but Truck 3 was assigned." }
  ]
}
```
- `outcome`: `match` (arrived == assigned, no-op) · `mismatch` (assignment exists & differs → **warning only, no write**) · `autoset` (no assignment existed → wrote `source: "inferred"` + warning to notify) · `noarrival` (no first arrival yet).
- Reads `geofence_alerts` (`event_type='job_arrive'`, `vehicle_number` → `truckKey`). Never writes over a `manual`/`default` row.

---

## 6. Not in this contract (Phase 1 scope guard)

No automated customer messaging, no customer-facing endpoint, no multi-truck-per-route payload, no capacity/dump-detour fields. Those are the deferred items in `plan-truck-route-eta.md` §3 and get their own contract when built.
