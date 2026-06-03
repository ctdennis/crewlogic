# CL-SPEC-002 — Town-name Price Lookup (town → ZIP → price)

Status: **Built & shipped to prod** (v5.22.2, promoted 2026-06-02; design locked 2026-06-02; spec'd
2026-05-29). Dual-track town lookup is live: **native** = autocomplete from enriched `price_list_zips`;
**Vonigo** = town + state dropdown scoped to `cost_settings.serviceStates` (default `officeState`).
Verified in-browser on dev (native: Dennis → Waterford price; Vonigo: MA/RI dropdown + village-name
not-found message). Migration 0005 applied to **dev and prod**.

## 1. Goal
The home-page Price Lookup takes a 5-digit **ZIP** (`#priceZipInput` → `doZipLookup()` →
`priceLookup({zipCode,…})`). Add the ability to enter a **town/city name** instead, resolve it to a
ZIP, and run the existing lookup. Callers/owners often have a town, not a ZIP. The resolution method
differs by provider (see §3) but both feed the **same** existing `priceLookup(zip)` path — so the
pricing backend is untouched.

## 2. Two provider tracks (the core of this design)
A franchise's `pricingSource` (`native` | `vonigo`, on `currentUser`) selects how a town resolves to a ZIP:

| | **Native track** (`pricingSource === 'native'`) | **Vonigo track** (else) |
|---|---|---|
| ZIP source | The franchise's own `price_list_zips` rows | None stored (Vonigo prices any ZIP via its zones) |
| Town→ZIP | **Local** — search the enriched `price_list_zips` (each row carries `city`/`state`) | **Live** — Zippopotam forward lookup `/us/<state>/<city>` |
| State input | None — each ZIP already carries its state, so the town list spans all served states automatically | A **state dropdown scoped to the franchise's served states** (`cost_settings.serviceStates`), default = `officeState` |
| UI | Town **autocomplete** from the franchise's own towns (typeahead, fuzzy-friendly, no typos) | Town text field + scoped state dropdown |
| Fuzzy? | Yes — it's our local data, so substring/typeahead matching is ours to control | No — Zippopotam is exact-match (case-insensitive only); typos → "not found" |

**Why the split:** Zippopotam's town endpoint *requires* a state (`/us/<state>/<city>`); there is no
"search all states by town." Native tenants already store their ZIPs, so we resolve the state from our
own data (and get free fuzzy autocomplete). Vonigo tenants store no ZIPs, so the user supplies the
state — but from a **short dropdown of just their served states**, not all 50.

## 3. Town → ZIP resolution
Use **Zippopotam.us** — free, no API key, no data to host (CORS `*`, confirmed 2026-06-02), both directions:
- **Forward** (Vonigo): `GET /us/<state-abbr>/<city>` → `places[]` with `post code`. Pick the
  **lowest-numbered ZIP** as primary (pricing is townwide-uniform, so the pick only affects the *displayed*
  ZIP; lowest = the main/central ZIP in most US towns). 404 → "town not found".
- **Reverse** (native enrichment): `GET /us/<zip>` → `place name` + `state abbreviation`. Used once per
  ZIP to populate `price_list_zips.city`/`.state`, then never again.

### Native enrichment
`price_list_zips` gains `city text` + `state text` (migration 0005). They are filled client-side
(CORS is open) by `enrichZipTowns(franchiseId)`:
- on **zip-save** (`pbAddZips`) — enrich the newly-added ZIPs, and
- **lazily** when the native town index is first built — backfill any rows still missing `city`/`state`
  (covers pre-existing rows, e.g. the 14 dev seed rows).
Enrichment only touches rows where `city is null`, so it is idempotent and self-healing.

### Native town index → ZIP
Build `{city, state, zip}` from the franchise's `price_list_zips`; dedupe by `city+state` to the
**lowest ZIP** (townwide-uniform pricing). The autocomplete offers "City, ST"; selection resolves to that
ZIP. A town that spans several ZIPs is therefore one entry → its lowest ZIP.

**Rejected alternatives** (unchanged from discovery, still apply): PO-box filtering via serviceability
(disproven — Vonigo prices PO-box ZIPs identically). Hosting a city dataset for fuzzy Vonigo matching =
the maintenance we're avoiding; Vonigo stays exact-match.

**Google Geocoding — re-evaluated 2026-06-02, deferred.** Google *does* resolve what Zippopotam can't:
administrative town names (e.g. **Bourne, MA** — which USPS files only under village names like Buzzards
Bay 02532, so Zippopotam returns empty), typo correction ("Borne"→"Bourne"), and **full street
addresses** → exact ZIP. The original blocker (client `STREET_VIEW_KEY`/`SIGNS_MAPS_KEY` are
referrer-restricted → `REQUEST_DENIED`) is solvable via the existing server-side `GOOGLE_GEOCODING_API_KEY`
edge-fn hop (already used for signs reverse-geocoding). **Decision:** keep Zippopotam for now — avoid the
per-lookup Google billing + edge hop — and instead make the Vonigo "not found" message guide the user to
the postal/village name (e.g. Bourne → Buzzards Bay) or the ZIP. Revisit if town lookup needs to accept
full street addresses or admin town names broadly.

## 4. Served states (Vonigo) — `cost_settings.serviceStates`
- Stored as a JSON array of 2-letter codes in the existing `cost_settings` blob (next to `officeState`).
  **No migration, no edge-function change** — `saveFranchiseInfo()` already persists the whole
  `costSettings` object via `crewlogic-settings`.
- **Owner-editable** in Settings → Company Info (a small "States served" field, comma-separated).
- **Default**: the dropdown pre-selects `officeState` every lookup (not last-used).
- **Single-state majority**: if `serviceStates` is empty, fall back to `[officeState]` → the dropdown has
  one option (effectively moot). Only the multi-state handful ever configure anything.
- **Captured at onboarding** (future — see `docs/STATUS.md` "Onboarding process"): new-Vonigo
  provisioning will ask which states they serve and seed `serviceStates`.

## 5. Flow
```
Native:  [Town autocomplete from price_list_zips] → city → lowest ZIP → doZipLookup() → render
Vonigo:  [Town] + [State ▾ (served states, default officeState)]
           → Zippopotam /us/<state>/<city> → lowest ZIP → doZipLookup() → render
```
Both pre-fill `#priceZipInput` and reuse the existing `doZipLookup()` → `priceLookup(zip)`, which already
routes native (`crewlogic-pricing`) vs Vonigo (`crewlogic-price-lookup`). Backend untouched.

## 6. Edge cases
- Town not found (Vonigo 404 / native not in index) → "Town not found — check spelling, or enter the ZIP."
- Network / Zippopotam down → fall back to the existing ZIP entry.
- ZIP resolves but isn't in the Vonigo service zone → existing "not in service zone" message.
- Native franchise with no ZIPs yet → "Add service ZIPs in Price Book to use town lookup."

## 7. Parked (not in this build)
- **Per-estimator default state.** Estimators (magic-link) may work in a different state than the
  franchise office (e.g. estimator in CA, office in AZ). A per-estimator default state (falling back to
  franchise `officeState`) is parked as a future enhancement, tracked under "Onboarding process" in
  `docs/STATUS.md`. For now the default is always `officeState`.

## 8. Build checklist
- [x] Migration `0005`: `price_list_zips` + `city`/`state` + town index; **applied to dev** (columns confirmed).
- [x] `enrichZipTowns()` — reverse Zippopotam on zip-save (`pbAddZips`) + lazy backfill in `buildNativeTownIndex`; idempotent (`city=is.null`).
- [x] `serviceStates` field in Settings → Company Info (comma-separated, owner-editable); save/load via `cost_settings` (no migration/edge-fn change).
- [x] Provider-aware town UI: native autocomplete (`<datalist>`) from `price_list_zips`; Vonigo town + scoped state dropdown (default `officeState`). `setPriceLookupMode()` branches on `_plIsNative()`.
- [x] Wire both into existing `doZipLookup()` (pre-fill `#priceZipInput`) — no backend change.
- [x] Errors: town-not-found (native index miss / Vonigo 404), network fallback, no-ZIPs-yet (native).
- [x] Verify in dev: schema applied, 14 dev ZIPs reverse-resolve (New Bedford 02744/45/46 → dedupes to 02744), HTML parses clean, **in-browser end-to-end confirmed** on dev v5.22.2 — native autocomplete (Dennis → Waterford price) + Vonigo scoped MA/RI dropdown + village-name not-found message. Migration 0005 applied to **prod**; promoted prod 2026-06-02.
