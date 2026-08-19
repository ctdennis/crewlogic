# CrewLogic Desktop Page Standard

Owner-set standard (2026-08-18) for **desktop** pages (≥1024px, inside the FW-68 shell). Mobile (<1024px)
always collapses to the existing single-column mobile UI, unchanged. "Dashboard" here means a
**desktop-oriented** layout — not a phone screen stretched wide.

## The rules

1. **Fluid column grid.** Content lays out in columns that **stretch and shrink with the viewport** —
   wider screen → wider columns; narrower → narrower. Use CSS Grid with `grid-template-columns: repeat(N,
   minmax(0,1fr))` (each column `1fr`), N = 3 on a normal desktop. Never fixed-pixel columns.

2. **Aligned tops.** Every column starts on the **same top line** — `align-items: start` on the grid. The
   page reads as clean rows of cards, not a staggered/masonry stream.

3. **Balance the portlets across columns.** Distribute cards as evenly as possible. Order them so
   **similar-height cards share a row** (put the big cards together, the small ones together) — this keeps
   rows tight and avoids one tall column next to an empty one. No "4 in column 1, 1 in column 2".

4. **Use the width; don't run off the bottom unnecessarily.** Break a screen's content into **portlets that
   fan across the width** instead of one long vertical stream. Long lists become a **pick-one → detail**
   view (select a day/route/item and show just that) rather than an endless scroll. A very large franchise
   may still scroll; the common case fits on one screen.

5. **Responsive collapse.** 3 columns → 2 → 1 as the viewport narrows (breakpoints ~820px, ~520px), so the
   layout degrades cleanly and the phone gets the single stack.

## Reference implementations (the canonical patterns)

- **Home dashboard** — hero KPI row + a "needs attention" band + grouped stat sections, full-bleed, tops
  aligned. The template for any future dashboard.
- **Disaster Recovery** — calendar (pick a day) → that day's detail + a side panel, instead of one long
  list. The template for any "long list of dated things" screen.
- **Settings (desktop)** — left category rail + a 3-column portlet grid per category (this standard). The
  template for any multi-group configuration screen.

## Canonical CSS (copy this)

```css
/* desktop page portlet grid — fluid columns, aligned tops */
.page-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 18px; align-items: start; }
@media (max-width: 820px) { .page-grid { grid-template-columns: repeat(2, minmax(0,1fr)); } }
@media (max-width: 520px) { .page-grid { grid-template-columns: 1fr; } }
```

Portlet ordering is authored (not automatic): list the cards big→big→big, then small→small, so row 1 is a
tidy row of the tall cards and row 2 mops up the short ones.

## What this replaces / forbids

- One long vertical stream of stacked cards on desktop (the "phone stretched wide" look).
- CSS multi-column / masonry that staggers card tops.
- Fixed-pixel column widths that don't flex with the screen.
- Content running off the bottom when it could fan across the width.

## Related

- `docs/plan-desktop-ui-redesign.md` — FW-68 desktop shell (the frame these pages live in).
- Settings desktop redesign is the first build to this standard (TaskList).
