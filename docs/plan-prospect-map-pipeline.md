# Plan — B2B Prospect Map + Prospecting Pipeline (FW-71)

**Status:** DISCOVERY / mechanics being designed with owner · created 2026-08-21 · no code
**Origin:** NY franchise request (a Google-My-Maps-style business-layer map). Owner reframed it into a
prospecting tool: Google-search businesses by type -> select -> drop as map layers -> manage in a pipeline.
**Register:** FW-71 (`.HUB/Hub.md` Future-Work Register)
**Related:** FW-66 Biz-Dev Conversion Workspace, FW-64 Sales-Activity Calendar, the Follow-up Pipeline,
existing Leaflet maps (dispatch / trucks / yard-signs), existing geocoding + route optimizer.

---

## The reframe (why this isn't just Google My Maps)
Google My Maps already does "pin businesses + toggle layers" for free. CrewLogic earns its place only by
(a) **sourcing** the businesses via search, (b) **managing them in a pipeline**, and (c) **overlaying our
own job/customer/route data**. The map is the acquisition + visualization surface; the value is the
pipeline behind it.

## What the owner asked for (2026-08-21)
1. **Search Google for a business type** — storage units, property managers, apartment complexes, etc. ->
   produce a **list**.
2. **Select from the list** — individually or all -> place as a **layer** on the map.
3. **Icon + color per layer** (owner wants that flexibility).
4. **Provenance** — track **when** each business was added and **by whom**.
5. **Into the pipeline** — added businesses become prospects to be **managed**; "determine the best flow /
   mechanics" is the open design question.

---

## Recommended mechanics

### Core insight: a prospect is a NEW object, not a job
The existing Follow-up Pipeline / FW-66 manages **transactions that convert to a booked job**
(lead -> estimate -> job, via Vonigo). A storage facility you want as a **referral partner** is not a job —
it's a relationship nurtured over many touches, whose "conversion" is *"starts sending us business."*
Forcing prospects into the job pipeline is the wrong model. Prospects get their **own light B2B pipeline**,
and they **hand off** to the job flow only when a real opportunity appears.

### Data model (relational, not a JSON blob)
- `prospect_businesses` — id, tenant_id, franchise_id, **google_place_id** (stable unique key), name,
  address, lat, lng, phone, website, `business_type` / layer_id, stage, icon, color (nullable override),
  notes, **added_by**, **added_at**, source (`google_places`), search_query.
- `prospect_layers` — id, tenant/franchise scope, name, icon, color (the per-type default look).
- `prospect_stage_events` — prospect_id, from_stage, to_stage, by_user, at (the provenance/audit trail
  for stage changes, beyond just "added by/when").
- Visits reuse **FW-64 `sales_activities`** (a visit is a timed activity linked to a prospect_id, with an
  outcome) rather than a parallel table.

### Stages (B2B, distinct from the job pipeline)
`New -> Researching -> Contacted/Visited -> Engaged -> Partner (converts)` with a `Not-a-fit` dead branch.
Simple, editable; the point is a worklist + a status, not a heavy CRM.

### Search -> select -> place (the acquisition flow)
1. User picks a **business type + area** -> **Google Places API** search (server-side edge fn
   `crewlogic-places-search`, key held server-side, NEVER client). Text Search ("storage units in Fall
   River MA") or Nearby Search (type + location + radius). Returns name/address/lat-lng/place_id/phone/
   website; ~20 per page, paginated.
2. Results shown as a **checkbox list**; select some/all; assign to a **layer** (existing or new) with an
   **icon + color**.
3. **Dedup by `google_place_id`** — a result already tracked shows its current stage badge ("already in
   pipeline") instead of re-adding. (Google's stable place_id sidesteps the Vonigo duplicate-customer
   problem entirely.)
4. Selected -> written to `prospect_businesses` with provenance -> appear as a map layer + enter the
   pipeline at `New`.

### Two views of the same data (code-reuse, not two features)
- **Map view** (Leaflet) — layers by business type, toggle on/off, icon+color per layer; overlay
  CrewLogic data layers (past jobs, commercial customers, pipeline items — see FW-71 sibling value-adds).
- **List/board view** — the same prospects as a worklist to manage stages, notes, next action.

### Visit + hand-off flow
- Plan visits (optionally **route-optimized**, reusing the existing engine) -> each visit is a **FW-64
  sales activity** with an outcome -> outcome **advances the prospect's stage**.
- When a prospect yields a real opportunity (wants a quote / refers a job), **create the estimate/lead in
  the normal flow, linked back to the prospect** — which also gives referral-source attribution
  ("this storage facility has sent us 5 jobs").

---

## Open decisions (owner input needed)
- **D-1 Where the pipeline lives:** a dedicated Prospecting module (recommended) vs a new object type
  inside FW-66's Biz-Dev Workspace. Recommendation: dedicated module that **feeds** FW-66/Vonigo on
  conversion, because the object + stages differ from the job pipeline.
- **D-2 Google Places dependency + cost:** Places API is paid per search and needs enabling on a Google
  Cloud project (reuse the existing CrewLogic Maps project + add billing) with a server-side key.
  **Meter searches** like AI calls. Approve the dependency before build (technology-selection rule).
- **D-3 Icon/color scope:** per-**layer** default (recommended — Storage=blue box, Property Mgr=green
  building) with an optional per-business override.
- **D-4 Data freshness / ownership:** who maintains the list; do we re-pull Places periodically or is it a
  one-time add? (Adoption risk if it rots.)
- **D-5 Scope:** NY/#90 pilot vs product feature for all franchises (sets investment + Pro/Enterprise
  line).
- **D-6 CrewLogic overlays in v1:** which of past-jobs / commercial-customers / pipeline overlays ship
  with P0 vs later.

## Phasing
- **P0 — acquisition + map:** Places search -> select -> drop as layers (icon/color) + provenance + dedup.
  New tables + `crewlogic-places-search` edge fn + a Leaflet screen. The visible core.
- **P1 — prospect pipeline:** stages, list/board management, notes, stage-event audit.
- **P2 — visits + routing:** route-optimized visit planning + FW-64 activity integration (visit -> outcome
  -> stage).
- **P3 — hand-off + attribution:** create estimate/lead from a prospect, link back for referral-source
  reporting.

## Guardrails
- Places API key server-side only; searches metered.
- Multi-tenant scoping on every table (tenant_id / franchise_id).
- Relational model, not a settings JSON blob (structured entities + audit + spatial).
- New screen -> regression-guard the single-file app; additive only.
- Any customer/pricing hand-off inherits the existing estimate/Vonigo gates.

## Next step
Owner resolves D-1 (pipeline home) + D-2 (approve Places dependency) -> then draft the P0 data contract
(tables + `crewlogic-places-search` shape) before any code.
