# Vonigo, Dispatch & Map — Design Decisions + Data Learnings

_Living record of the design thresholds crossed and the Vonigo knowledge earned building the
dispatch board, the trucks map, the DR mirror, and crew inference (2026-07). Keep it current —
when a decision changes or we learn a new Vonigo fact, edit the relevant section here._

Related: `.HUB/Hub.md` (status), `docs/contract-vonigo-adapter.md`, `docs/plan-truck-crew-inference.md`,
`docs/graphics/` (icon explainers), and the AI memory notes referenced inline.

---

## 1. The map job icon (the "house")

Every job on the Where-Are-My-Trucks map is a house glyph. It encodes **three** things at once:

- **Outer ring = ROUTE.** A thick (4px), no-white, route-colored border. Route color is deterministic
  (§3), so the same route is the same color on the map ring AND the board's route-cell bar.
- **Inner fill = STATUS.** The exact Vonigo appointment-label color (§4).
- **Number = STOP ORDER** on the route (1st, 2nd…). Centered in the house body
  (`dominant-baseline="central"`, y=14) — the old y=18.5 sat low.

**Truck-under-a-job badge:** when a truck sits over a job (≤60m), a small house badge draws on the
truck marker with the **same label fill + route ring**; it **touches** the disc (overlaps the
bottom-right) with a thicker (4.5px) ring so the route reads at that size.

Explainer PNGs live in `docs/graphics/` (job icon, truck marker, truck-on-job, the 4 truck states).

## 2. Board + map colors = Vonigo parity (one gray exception)

Board tiles and map fills use the **exact Vonigo appointment-label colors**. The **only** non-parity
color is **gray `#5b6b7a` for a fully paid + completed job** (Vonigo status 164/165) — kept because a
paid job shouldn't be draggable. Everything else mirrors Vonigo; Lost shows its Vonigo red, not gray.

This **replaced** a 2026-07-06 dispatch overlay (amber "estimate taken" `#ffab00`, bright-green
"do work now" `#22c55e`, dark-blue national-account) that had masked the real colors. Lesson: don't
invent a second color language on top of the CRM's — mirror it, and reserve exactly one signal (gray)
for the one thing the CRM color can't tell you (is it locked/paid).

Full label→color map + the estimate booking/conversion flow: **memory `vonigo-appointment-label-colors`**.

## 3. Route color-coding (`mjRouteColor`)

- **Deterministic + sequential:** colors are assigned per **normalized route code** (so "Route 3
  (MA3ALL)" and "MA3ALL" hash the same), one distinct palette color per route in first-seen order —
  **not a hash** (hashing collided MA2FAR≈RI4REG). A shared map keeps map and board in sync.
- **Palette is deliberately OFF the Vonigo label hues** (warm + teal: orange/teal/magenta/gold/…),
  because the labels already own blue, the greens, purple, and red — a route ring in those hues reads
  like a status fill. Palette holds 10 routes before repeating (widen for NYC-scale franchises).
- **Shown as a thin accent, never a full fill:** the map house **border** and the board's route-label
  **cell left-bar** (inset stripe, like the pricing-zone stripe). Full-color route cells looked like a
  "Partridge Family bus" — owner-rejected.

## 4. Truck marker states + the red unplugged flag

`TRUCK_STATE_COLOR` (index.html) — disc color = telematics status:

| State | Color | Meaning |
|---|---|---|
| moving | green `#00E785` | actively driving (this state shows the direction **nose**) |
| parked | sky-blue `#38bdf8` | reporting, sitting still |
| stale | gray `#6e8194` | no report in 1 hr+ / no timestamp |
| **offline / unplugged** | **red `#ef4444`** | **device unplugged — HIGH RISK** |

- **Nose** = direction of travel; only rendered while moving. **Number** = the truck's map order.
- **Unplugged = red on purpose (owner 2026-07-24):** unplugging hides the driver from the GPS +
  dash-cam (smoking, phone use, inattentive driving), so it's a red flag, not a neutral "offline."
- A **bold-red UNPLUGGED banner** (`_offlineTruckAlertRows`) pins to the top of the truck list AND the
  Live Alerts rail the moment a truck goes offline.

## 5. Vonigo board parity — "booked online" + "booked same-day"

Two visual cues Vonigo shows that we now replicate on the dispatch board:

- **Booked online → diagonal stripes (`//////`, 135°, uniform 4px).** Signal: **WorkOrder note
  field 200 == "Online booking."** — the online-booking widget auto-stamps that note.
  - **NOT** the lead-source field (Job field **969** = campaign/marketing channel, e.g. "Internet -
    Other/Search"): internet-sourced ≠ self-booked (Petrarca/Flack are internet-sourced but agent-booked).
  - Job field **978 = "Created via API"** usually indicates online too, but isn't definitive.
- **Booked same-day → thin orange bottom edge.** Signal: **WorkOrder `dateCreated` calendar-day ===
  `dateService` calendar-day**, compared in the **franchise timezone** (`franchiseTz()` + `ymdInTz()`).

Both computed in `crewlogic-dispatch` `boardGrid` and rendered on the board tile in `mjRenderBoard`.
Memory: `vonigo-booking-source-and-sameday-signals`.

## 6. Vonigo data reference (what the pulls actually contain)

- **Objects:** `/data/WorkOrders/`, `/data/Jobs/`, `/data/Quotes/`, `/data/Contacts/`,
  `/system/objects/`. Auth = MD5 `/security/login/` (no OAuth). The **WorkOrder** is the appointment;
  the **Job** is its parent; the **Quote** is the estimate/pricing.
- **`isCompleteObject:'true'`** returns each object's `Fields` + `Relations` **and** top-level
  metadata. **WorkOrder top-level** carries the timestamps we need: `dateCreated`, `dateLastEdited`,
  `dateService`, `dateCompleted`, plus `objectID`, `countWorkOrders`, `countQuotes`, etc.
- **Key WorkOrder field IDs:** 181 status · 183 on-site contact · 184 address · 185 service-date epoch
  · 186 duration · **200 notes** · **201 appointment label** · 813 price · 9082 start-minutes (from
  franchise-local midnight; 720 = noon) · 10336 items. Phone/email live on the **Contact** object
  (1088 / 97), not the WO.
- **Key Job field IDs:** 969 lead source (campaign channel, NOT booking method) · 978 free-text
  ("Created via API" for online) · 982 service type · 984 status.
- **Label 201 optionID→name→color** and the booking/conversion process: memory
  `vonigo-appointment-label-colors`. **Status 181** + label codes: memory `vonigo-status-and-label-codes`.
- **Crew:** WorkOrder `Relations` where `relationType='crew'` → crew names ("Last, First"). The mirror
  stores them as `job_source_snapshot.crew_display`. Crew is per-**job**, never per-truck.
- **Routes/availability API:** memory `vonigo-routes-availability-api`. **Price lists:** memory
  `vonigo-pricelist-10-cap` (no write/import API — copy manually).

## 7. Data pipeline (which function feeds what)

| Surface | Data source | Notes |
|---|---|---|
| Dispatch **schedule board** (`mjRenderBoard`) | `crewlogic-dispatch` `boardGrid` | live Vonigo pull |
| Trucks **map** + job markers | `crewlogic-todays-workorders` | live Vonigo pull |
| **Backup Schedule** (DR mirror) | `crewlogic-vonigo-import` → `job_source_snapshot`; read via `crewlogic-jobs` | nightly + 15-min sync; 3-month retention |
| **Live Alerts** rail + geofence reports | `geofence_alerts` (Motive webhook) → `crewlogic-geofence-alerts` | service-role, token-independent |
| **Crew inference** | `crewlogic-geofence-alerts` `crew-infer` | `job_arrive` events × `crew_display` |
| Route optimization | n8n (`N8N_BASE + /crewlogic-route`) | the one live n8n dependency |

## 8. Testing constraints (hard-won — don't forget these)

- **Dev has NO Motive `job_arrive` data** (only facility geofence events). So **crew inference** and the
  geofence **job**-alerts can't be visually tested on dev — they're **prod-only**. Validate logic via
  prod read-only SQL, ship, verify on prod.
- **`crewlogic-estimate` has `VONIGO_READONLY` on dev** (blocks all Vonigo writes). The estimate-post
  label write (sets WO field 201 = 9996) is **prod-only-testable**.
- **Unplugged truck** and **same-day booking** can't be conjured on demand — the code paths are simple;
  verify when they naturally occur.

## 9. Architectural patterns worth reusing

- **Token-independent reads:** client features that read Supabase directly via PostgREST + RLS
  (`to authenticated`) go **silently empty** when a Google session's token drops (e.g. after a refresh).
  Fix = a **service-role edge function scoped by `franchiseInternalID`** (pattern: `crewlogic-jobs`,
  `crewlogic-geofence-alerts`). Memory `direct-rls-reads-break-on-token-expiry`. Don't blanket-migrate
  the 100+ working direct reads — only the ones that actually show the symptom (early-on-load surfaces).
- **Timezone:** multi-tenant across US zones. Use `franchiseTz()` + `_shared/tz.ts` (`ymdInTz`,
  `dayIDInTz`); never hardcode Eastern. Wall-clock→epoch must be DST-aware.
- **UI state preservation:** every `render*()` rebuilds via `innerHTML` and destroys open dropdowns /
  focus / scroll — a bug whenever it can fire mid-interaction (auto-save, poll, fetch). See the
  "UI state preservation" section in `CLAUDE.md`.
- **Adds-a-CRM = rows, not columns:** the canonical job model (`jobs`/`job_appointments`/…) stays
  provider-neutral; Vonigo-specific extras live in `job_source_snapshot`.
