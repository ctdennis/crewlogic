# QA Test Plan — v5.100.0 (FW-60 Phase 1: AI Volume / Load Forecast)

**Environment:** https://dev.crewlogic.pages.dev (dev Supabase). **Risk:** MEDIUM (new flow + persisted writes).
**Version check:** open DevTools Console (F12) → confirm the startup banner reads **v5.100.0**. Hard-refresh first.
**Account:** sign in with the injected **🔧 Dev sign-in · Vonigo #90** button.

Off = today's board. The load forecast only appears when you press the AI button, so nothing changes until you opt in.

---

## Test 1 — Feasibility opens in the LEFT RAIL (was a modal)
1. Go to **Dispatch**. Wait for the board + map to load.
2. Tap a **route-code cell** (left column, e.g. MA1REG) on the board.
   - **Expected:** the route's feasibility breakdown opens in the **left details rail** (not a pop-up modal). It shows the per-stop arrival breakdown + a new **🚛 Load forecast** section at the bottom with an **🔮 Estimate volume (AI)** button.

## Test 2 — Estimate volume (the AI call)
1. In that panel, click **🔮 Estimate volume (AI)**.
   - **Expected:** brief "Estimating…", then each stop shows an **AI range** (e.g. "AI 3–10 cy · low"), a **slider**, a **cy value**, and a running **cumulative** badge on the right. A **fill bar** + summary appears at the bottom ("Fills at <stop>…" or "Stays under one truck …"). If cumulative crosses the truck size, the crossing stop shows **🛢️ Truck full here**.
2. Click **↻ Refresh**.
   - **Expected:** returns immediately with the SAME numbers (no re-estimate) — cached, no AI spent.

## Test 3 — Slider moves the fill point IN PLACE (mid-interaction / UI-state)
1. Drag a stop's slider up to a large value (e.g. max).
   - **Expected:** that stop's **cy value + cumulative update live**, the **fill bar grows**, and the **🛢️ marker jumps** to the stop where it now crosses full — all WITHOUT the panel jumping, flashing, or the slider resetting mid-drag.
2. **Scroll the rail down** so a lower stop's slider is visible, then drag THAT slider.
   - **Expected:** the panel **stays put** (no scroll-to-top, no re-render); only the numbers/bar/marker change.

## Test 4 — Persistence read-back (the write path)
1. Set a stop's slider to a clear value (e.g. **7.00 cy**). Note the stop + value.
2. **Hard-refresh** the page, go back to **Dispatch**, tap the same route cell, press **🔮 Estimate volume (AI)** again.
   - **Expected:** that stop comes back **seeded at 7.00 cy** (your saved actual), its meta line shows **"· set"**, and — importantly — **Refresh did NOT re-run the AI** for the other stops (they're cached).

## Test 5 — Estimate-only convert
1. Find an **Estimate-only** stop (EST route, or a stop shown as "Estimate-only — not counted").
   - **Expected:** it shows **"Estimate-only — not counted"** and does NOT add to the cumulative.
2. Click **"converted → count it"**.
   - **Expected:** the stop gains a slider (seeded at its AI midpoint), now **counts** toward the cumulative, and the fill point recomputes. An **"undo"** link is available.

## Edge-function API smoke (optional, stable contract)
Against the dev function `crewlogic-volume` (already smoked server-side):
- [x] estimateRoute fresh → aiCalls:N, ranges + confidence returned.
- [x] estimateRoute repeat → aiCalls:0, all cached, estimates stable.
- [x] setActual / setEoConverted persist and surface on re-fetch without re-triggering AI.

---
**Pass/Fail + notes per test. Report anything where the panel jumps, a slider resets mid-drag, or a saved value doesn't come back.**
