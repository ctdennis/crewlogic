# Plan / Scope — Vector traffic (road-class-aware, crisp)

**Status:** SCOPE for owner review (2026-07-03). No build until approved.
**Goal:** crisp traffic on the trucks map that shows **major roads (highways) when zoomed out** and **all roads when zoomed in** — no blur.

**Why the current raster can't do it:** TomTom's *raster* traffic tiles bake a fixed road set into each zoom level and have **no road-class filter**. The zoom-offset trick (tried in v5.48.31) upscales a lower-zoom tile → fewer roads but **blurry**. **Vector** traffic tiles carry per-segment properties (road class + traffic level), so you can **style + filter by class and zoom** → crisp *and* selective. That's the real fix.

---

## Reframe: we probably DON'T need to rebuild the whole map

"Vector engine" sounds like replacing Leaflet with MapLibre GL — a huge rewrite. But there's a **lighter path**: add a vector *traffic overlay* on the **existing Leaflet map**, leaving every other map feature untouched. Two approaches, cheapest first:

### Approach A — Vector traffic overlay on Leaflet (RECOMMENDED)
Keep the entire current Leaflet map (base tiles, truck/job/site/home markers, measure route-line, disposal-route plotting, layer control, both trucks-screen + dashboard contexts) **unchanged**. Only the traffic layer changes.

- Add **Leaflet.VectorGrid** (a Leaflet plugin that renders MVT vector tiles).
- Add **TomTom vector traffic flow tiles** as a VectorGrid layer.
- A **style function**: color by traffic level (green/amber/red), width by importance, and a **zoom + road-class filter** — hide minor road classes below a zoom threshold → majors-only zoomed out, everything zoomed in. Vector = crisp at every zoom.
- Swap the existing 🚦 Traffic toggle to this vector layer (keep the toggle, default-on, persistence, and under-Hybrid positioning as-is).

**Effort:** moderate. **Risk:** Leaflet.VectorGrid is a community plugin (older but works with Leaflet 1.x); TomTom vector-flow tile schema needs verifying.

### Approach B — Rebuild the trucks map on MapLibre GL JS (HEAVIER fallback)
Replace Leaflet entirely with MapLibre GL (WebGL vector renderer) + a vector base style + TomTom vector traffic styled natively by road class/zoom.

- **Rewrites ALL trucks-map code**: base map, every marker type, popups, the measure route-line, disposal-route plotting, the layer control (custom UI — MapLibre has no `L.control.layers`), both map contexts, mobile + desktop.
- **Effort:** large — a major rewrite of one of the biggest features. Highest fidelity + future-proofs the map, but big and risky.
- Only pursue if Approach A can't deliver.

---

## Recommended next step: a SPIKE of Approach A (before committing to any build)

A short spike to prove the concept + retire the unknowns:
1. **Does the TomTom key have vector traffic flow tiles?** (The key's permissions showed "Traffic Flow API" + "Orbis Traffic Flow API Extended Tiles" enabled → likely yes.)
2. **The TomTom vector-flow tile URL + MVT schema** — the layer name(s), the road-class property, the flow/congestion property.
3. **Does Leaflet.VectorGrid render + perform acceptably** on the existing map (regional view + zoomed in, both contexts, mobile)?
4. **Can the style function filter by road class + zoom** to get crisp majors-out / all-in?

**Outcome:** if the spike renders crisp road-class traffic on the Leaflet map → Approach A is the whole solution (moderate build: add the plugin, the layer, the style function, swap the toggle, test, promote). If it hits a wall → we scope Approach B (the MapLibre rewrite) with eyes open.

---

## Build scope IF Approach A proves out
- Add Leaflet.VectorGrid (CDN, in `<head>` with the other map libs).
- TomTom vector traffic source + a VectorGrid layer (client-side, domain-locked key — same as the raster tiles + routing).
- Style function: flow color, class-based width, zoom+class filter (threshold TBD, e.g. majors-only below ~zoom 11).
- Replace the raster `_trafficLayer` with the vector layer; keep the 🚦 Traffic toggle, default-on, localStorage persistence, and under-Hybrid positioning.
- Test: crispness at all zooms, majors-out/all-in, both map contexts, mobile + desktop, tile/perf load. Dev first → promote.

## Risks / notes
- **Leaflet.VectorGrid dependency** — community plugin, not actively maintained; pin a known-good version; the spike de-risks it.
- **Quota** — vector flow tiles count toward the TomTom quota (per-tile, like raster); fine for a few dispatchers.
- **Fallback** — if VectorGrid perf/rendering is poor, keep the current crisp raster traffic (what's in prod now) as-is and reconsider Approach B.
- The domain-locked key already covers this (client-side vector tile fetch from the app's domains).

_Recommendation: run the Approach-A spike; decide the build from what it shows._
