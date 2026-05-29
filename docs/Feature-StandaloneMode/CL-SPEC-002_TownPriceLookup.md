# CL-SPEC-002 — Town-name Price Lookup (town → ZIP → price)

Status: **Documented, not yet built** (2026-05-29). Enhancement to the home-page Price Lookup.
Provider-agnostic: works for both Vonigo and native (no-CRM) tenants for free (see §5).

## 1. Goal
Today the home-page Price Lookup takes a 5-digit **ZIP** (`#priceZipInput` → `doZipLookup()` →
`priceLookup({zipCode,…})`). Add the ability to enter a **town/city name + state** instead, resolve
it to a ZIP, and run the existing lookup. Callers/owners often have a town, not a ZIP.

## 2. Inputs
- **Town**: free text entry.
- **State**: a US state selector (required). Needed because (a) the resolver API is keyed by state,
  and (b) town names repeat across states. **Default to the franchise's home state**; keep the
  selector for multi-state franchises (e.g. "Southeastern MA & RI" crosses MA/RI).
  - Open detail: CL has no explicit franchise `state` field today. Either derive a default from the
    franchise name (often encodes it) or default the dropdown to the most likely state and let the
    user change it. Minor.

## 3. Town → ZIP resolution (the only new piece)
Use **Zippopotam.us** — free, no API key, no data to host/maintain (the key reason for this choice;
owner wants zero new maintenance points and Vonigo has no API to pull serviced ZIPs per franchise):
- `GET https://api.zippopotam.us/us/<state-abbr>/<city>` (URL-encode the city).
- Returns `places[]` each with `post code` + lat/lng. Verified 2026-05-29 for New Bedford, MA →
  6 ZIPs: 02740, 02741, 02742, 02744, 02745, 02746.

**Pick the lowest-numbered ZIP as the "primary."** Rationale:
- Pricing is **uniform townwide** (owner confirmed), so the pick only affects which ZIP is *displayed* —
  the **price is always correct** regardless of which town ZIP is chosen.
- Lowest-numbered is the central/main ZIP in the large majority of US towns (postal numbering gave the
  base number to the main office). For New Bedford → 02740 = the actual downtown/main ZIP, and it
  naturally skips the off-center PO-box ZIP 02741.
- Optional robustness tweak if ever needed: pick the ZIP closest to the **median** of the returned
  coordinates (median is robust to PO-box outliers). Not needed given uniform pricing.

**Rejected alternatives:**
- Google Geocoding for an authoritative primary ZIP — the client `STREET_VIEW_KEY` is referrer-
  restricted and **cannot** call the Geocoding API ("API keys with referer restrictions cannot be used
  with this API", verified). Only the server-side `GOOGLE_GEOCODING_API_KEY` could, via an edge-fn hop —
  not worth the plumbing for a cosmetic gain.
- "Filter PO boxes via serviceability" — **disproven** 2026-05-29: Vonigo prices the PO-box ZIP 02741
  the same as 02740 (both → price list 768, identical values), so a serviceability check does NOT remove
  PO boxes. Truly tagging PO boxes needs a zip-TYPE dataset/USPS key = the maintenance we're avoiding.
  Moot anyway — uniform pricing + lowest-ZIP pick + not surfacing the raw ZIP list makes PO boxes invisible.

## 4. Flow
```
[Town text] + [State select]
  → Zippopotam (town → ZIPs)            // no key, no maintenance
  → pick lowest-numbered ZIP            // "primary"; price is townwide-uniform anyway
  → existing priceLookup(zip)           // already routes native vs Vonigo (see §5)
  → renderPriceResults(...)             // existing render
```
Lightest build: a town field that resolves to a ZIP and feeds the existing `doZipLookup()` path
(pre-fill the ZIP + reuse the current lookup/render), so the backend is untouched. Add a ZIP|Town
toggle or show both inputs.

## 5. Dual-provider — free
The town→ZIP layer is provider-agnostic. It hands the ZIP to the existing `priceLookup()` which already
routes by provider (`index.html` ~line 3463):
`const fn = (currentUser.pricingSource === 'native') ? 'crewlogic-pricing' : 'crewlogic-price-lookup';`
So Vonigo tenants hit `crewlogic-price-lookup` and native tenants hit `crewlogic-pricing` — same as the
ZIP box does today. Native pricing is keyed by ZIP via `price_list_zips` with a **Default** list catch-all,
so a resolved ZIP always returns a price for native tenants too.

## 6. Edge cases
- Town not found by Zippopotam → "Town not found — try the ZIP, or check the state."
- Ambiguous/multiple `places` → already handled by lowest-ZIP pick (no user disambiguation needed).
- ZIP resolves but isn't in the franchise's service zone (Vonigo) → existing "not in service zone" message.
- Network/Zippopotam down → fall back to the existing ZIP entry.

## 7. Build checklist (later)
- [ ] UI: town input + state selector (default home state); keep ZIP entry (toggle or both).
- [ ] `resolveTownToZip(city, state)` → Zippopotam fetch → lowest-numbered `post code`.
- [ ] Wire into `doZipLookup()` (pre-fill ZIP + run existing lookup) — no backend change.
- [ ] Errors: town-not-found, network fallback.
- [ ] Verify on a Vonigo tenant (New Bedford → 02740 → price) and a native dev tenant.
