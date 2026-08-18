# QA Test Plan — v5.126.0 — FW-68 Desktop Nav Shell

**Risk tier: HIGH** (touches global layout + navigation on desktop). Test on a **desktop/laptop** — this
feature is desktop-only. Phones are intentionally unaffected (test those too, to confirm nothing changed).

**Environment:** `https://dev.crewlogic.pages.dev` (dev preview, dev Supabase).
**Version check:** open DevTools Console (F12) — the startup banner should read **v5.126.0**. Or view-source
and confirm `<meta name="crewlogic-version" content="v5.126.0 | 2026-08-18">`.

**What shipped:** on a browser window **≥ 1024px wide**, a left navigation rail appears and the app fills the
window to the right of it. Below 1024px, the app looks and works exactly as before (no rail). The rail only
adds navigation — no screen was redesigned. The **Dispatch board must look identical** to today.

**Sign-in:** use the injected "🔧 Dev sign-in · Vonigo #90" button on the login screen.

---

## Conventions (read once)
- **"Make the window wide"** = maximize the browser on a desktop, or drag it wider than ~1024px. If you're on a
  laptop, full-screen is fine.
- **"Make the window narrow"** = drag the browser edge in until it's phone-width (< 1024px), OR open DevTools
  (F12) → device-toolbar (Ctrl/Cmd+Shift+M) → pick "iPhone".
- **Fresh window** = a new browser window/tab so no stale state carries over.
- After each nav click, the **screen title in the top header** should change to match (e.g. "Dispatch",
  "Biz Dev", "Follow-up Pipeline").

---

## A. Desktop — the rail appears and is correct (window ≥ 1024px)

| # | Step | Expected | P/F |
|---|------|----------|-----|
| A1 | Sign in, then make the window **wide** (≥1024px). | A dark **left rail** appears down the left edge with the **CrewLogicAI** brand at the top. The app content sits to the **right** of the rail and fills the window (no narrow centered column with side gutters). | |
| A2 | Read the rail top-to-bottom. | Groups in this order: **Dispatch** · **Estimates** (expanded, showing two sub-links) · **Business Development** · **Disaster Recovery** · **Yard Signs & Other Tools** (collapsed) · and **⚙ Settings** pinned at the bottom. | |
| A3 | Look at the two Estimates sub-links. | **CrewLogic Estimates** (bold) with a small line "estimates started & built here in CrewLogic", and **Margin Analysis** (bold) with "profit & margin review of Vonigo estimates". | |
| A4 | Click the **Estimates** group header (the row with the ▸ caret). | The two sub-links **collapse**; the caret rotates. Click again → they expand back. | |
| A5 | Click the **Yard Signs & Other Tools** header. | It **expands** to: Yard Signs · Recycling · Where Are My Trucks? · Price Lookup · Coupons / Campaigns · Job Plan. | |

## B. Desktop — every nav item opens the right screen

For each: click the rail item → confirm the correct screen loads AND the clicked item gets a green highlight.

| # | Click (rail) | Expected screen | P/F |
|---|--------------|-----------------|-----|
| B1 | **Dispatch** | The Dispatch board + map. **It must look exactly like it does today** — same route board, same live truck map, same behavior. Fills the window width. | |
| B2 | Estimates → **CrewLogic Estimates** | Your CrewLogic estimates list (the normal Estimates screen). | |
| B3 | Estimates → **Margin Analysis** | The Estimate Costing / margin screen (the estimate picker + Calculate volumes in the header). | |
| B4 | **Business Development** | The Biz Dev workspace (full width). | |
| B5 | **Disaster Recovery** | The backup-schedule screen. | |
| B6 | Tools → **Yard Signs** | The Yard Signs screen. | |
| B7 | Tools → **Recycling** | The Recycling screen. | |
| B8 | Tools → **Where Are My Trucks?** | The trucks map screen. | |
| B9 | Tools → **Price Lookup** | The Price Lookup screen. | |
| B10 | Tools → **Coupons / Campaigns** | The Coupon Lookup / promos screen. | |
| B11 | Tools → **Job Plan** | The Job Plan screen. | |
| B12 | **⚙ Settings** (bottom of rail) | The Settings screen. | |
| B13 | Click the **CrewLogicAI brand** (top of rail). | Returns to the **Home** screen; the rail's green highlight clears. | |

## C. Desktop — nothing else broke (regression)

| # | Step | Expected | P/F |
|---|------|----------|-----|
| C1 | From Home (wide window), use the **on-screen home tiles** (the old way) to open Dispatch, Estimates, Trucks, etc. | Every tile still opens its screen exactly as before. Both the rail AND the tiles work. | |
| C2 | Open **Estimates → CrewLogic Estimates**, start/open an estimate, add a charge, **Save Draft**. | The estimate editor works normally; save succeeds; the editor toolbar (Photo/Describe/Manual/More/Save) is intact. | |
| C3 | Open **Settings**, switch a couple of tabs, change and save one field. | Settings tabs and saves work exactly as before. | |
| C4 | Open the **Estimate editor**, then click a rail item to leave with unsaved changes. | The "save before leaving?" prompt still appears (unchanged behavior). | |

## D. Mobile / narrow — must be UNCHANGED (window < 1024px)

| # | Step | Expected | P/F |
|---|------|----------|-----|
| D1 | Make the window **narrow** (< 1024px) or use device-toolbar. | **No left rail.** The app looks exactly like the current mobile app — the centered column, the home tiles, the header with 💬 Feedback / ⚙ Settings. | |
| D2 | Tap around the home tiles: Dispatch, Estimates, Trucks, Signs, Recycling, Price Lookup, Job Plan. | Everything works exactly as it does today. Nothing moved or changed. | |
| D3 | Slowly drag the window across the ~1024px boundary (wide → narrow → wide). | The rail appears when wide, disappears when narrow, with no broken/half-state layout at the crossover. | |

---

## Pass criteria
- **All of section D passes** (mobile unchanged) — this is the hard regression gate.
- **B1 passes** (Dispatch board unchanged) — owner-stated requirement.
- Every B row opens the correct screen; every C row confirms no regression.

Any failure → note the row + what you saw; do **not** promote to prod. Prod promotion is a separate,
owner-gated step (merge `dev` → `main`).
