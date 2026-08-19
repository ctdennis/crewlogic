# Plan — Desktop Estimate Editor (drill-down)

**Status:** APPROVED design (owner 2026-08-19, mock v3). Building additively on `dev`, desktop-only (>=1024px).
Register: FW-68 follow-on (task #46). The estimate editor is the revenue-critical screen — build behind the
desktop breakpoint with a hard regression guard; the mobile estimate flow stays byte-for-byte unchanged.

## Approved layout (mock v3) — Miller / drill-down columns, left → right
1. **App nav** — the existing FW-68 workspace nav (unchanged).
2. **Estimates** — scroll of all estimates (name · address · total · Draft/Submitted/Won badge), **＋ New** at
   top of the list, search. Click one → opens it.
3. **Rooms · <customer>** — the selected estimate's rooms/areas (thumbnail · volume · $), **＋ Add** at top;
   below a divider, the estimate-level items: Totals & Pricing · Special Terms · Cost Analysis · Container vs Truck.
4. **This-room fields** — room/area, volume, recycle/donate %, description, room total.
5. **Photos** — scrollable, ~140px thumbnails, per room (AI badge + Add). Larger than mobile thumbs.
Running **Quote Total + Margin pinned top-right**, following the selected estimate.
Selecting a room → cols 4+5 = that room's fields + photos. Selecting an estimate-level item → col 4 shows that
card (photos col tucks away).

## Approach — reuse, don't rewrite
The editor already has all the logic: `openEstimateEditor()`, `renderCharges()` (#estChargesList; each charge a
collapsible card with fields + inline photos), `updateTotals()` (#estGrandTotal / margin), Special Terms & Cost
Analysis cards, all save/photo/AI handlers. The desktop layout is a **re-arrangement driven by a rooms rail**,
reusing those functions — NOT a reimplementation of pricing/photo/save logic.

## Phasing (land value fast, low risk)
- **Phase 1 — room-drill editor (desktop):** at >=1024, lay the OPEN editor out as `rooms rail | room fields |
  photos`, driven from the charges. Reuse renderCharges' per-charge fields + photos; show one room at a time;
  bigger photos; estimate-level items (Totals/Terms/Cost) as rail entries. Fixes the "narrow column, photos
  crammed upper-left" problem and delivers the core drill.
- **Phase 2 — persistent Estimates column:** add col 2 (all estimates + ＋ New + search) so you can jump
  estimates without leaving — the full 5-column Miller view. Reuse the estimates-list data/render.

## HARD REGRESSION GUARD
Additive, desktop-gated. Mobile (<1024px) editor + estimates list unchanged. No change to any save fn, pricing
calc, photo capture/AI, or Vonigo submit. Every existing input id preserved. A regression on the estimate flow
blocks the merge. Right-sized test = HIGH (revenue-critical + many touch points).

## Related
- docs/desktop-page-standard.md (fluid columns / aligned tops) · FW-68 shell · Estimates Desk (existing 2-pane
  precedent that relocates #estimateEditorScreen into a pane).
