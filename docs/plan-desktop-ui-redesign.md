# Future Project — Professional Desktop UI (responsive SaaS shell)

**Status:** BACKLOG / future project (captured 2026-08-16, owner). Not scheduled; not approved for build.
Register: **FW-68**. This is a LARGE, cross-cutting UI project — it will need its own approved plan + a strict
regression guard before any code.

## Problem
CrewLogic is intentionally **mobile-first / PWA** (fixed viewport, no user scaling — crews work from phones in
the field). The cost: when someone lands on a **desktop**, they get the narrow mobile UI, which looks
unprofessional and wastes the screen. The owner wants a **desktop landing to render a real desktop UI** —
the standard SaaS layout every comparable tool uses.

## Goal (one line)
On desktop, present a professional standard SaaS layout — **left-hand expandable nav · main content in the
center · account/settings in the upper-right** — while **preserving the current mobile UI for phones**.

## Reference pattern (owner-supplied: Motive, Linxup, CareerPlug, Google Cloud)
All four share the same skeleton:
- **Left rail:** the product's major features as a vertical list, with **expandable/collapsible sub-menus**.
- **Center:** the main content/work surface for the selected feature.
- **Upper-right:** account, settings, notifications, profile/org switcher.
- Persistent top bar; content scrolls, chrome stays.

## Proposed nav structure (owner's major features)
Left-rail groups (each expands to its screens):
1. **Estimates** — estimator, estimate editor, estimates list.
2. **Dispatch** — dispatch board, map, trucks / where-are-my-trucks.
3. **Business Development** — the Sales Workspace (FW-66) pipeline + booking.
4. **Disaster Recovery** — (define scope; may fold in the outage-insurance / job-mirror idea, FW-58).
5. **Other tools** — price lookup, coupons/campaigns, job plan, yard signs, etc.

(Exact screen→group mapping is a build-time step — every existing screen slots under one group.)

## Approach — RESPONSIVE split, not a rewrite
- **Desktop (>= breakpoint):** a new **app shell** wraps the existing screens — left nav + top bar + a center
  content region that hosts the SAME screens already in `index.html`. Navigation drives the existing
  `hideAll()` + `show*/render*` functions (there's no router; the shell's nav calls those). Upper-right =
  account/settings menu (profile, subscription, settings, sign out).
- **Mobile (< breakpoint):** unchanged — the current mobile-first UI stays exactly as-is.
- Detect by viewport width (with a sensible breakpoint), not hostname. The app already has desktop-width
  mechanisms to build on (the dispatch dashboard's full-width mode; see the full-width-desktop-screens note).
- **This is a NAVIGATION + CHROME reskin, not a screen rewrite.** The screens' internals stay; they get a
  desktop frame around them and a real nav to reach them.

## Settings — apply the SAME pattern (left categories · right columns/portlets)
Today's Settings is a row of **grouped icon-links across the top** — not professional-quality. Redesign it to
mirror the main desktop shell: a **left sub-menu of settings categories**, and the selected category's
**details on the right**, laid out in **columns / portlets** that actually use the wide screen (not one long
stacked column).

- **Left settings menu (owner's categories):** Franchise · Account · Trucks · Cost · Proposal · Routes ·
  Pricing · Yard Signs · Tools · … (the current settings tabs, moved to a left rail — click a category, its
  detail fills the right).
- **Right detail pane = multiple portlets in columns**, not one long form. Each portlet is a self-contained
  card (title + its fields). **Example — Franchise → a "Branding" portlet AND a "Company Info" portlet side
  by side.** Categories with many fields spread across 2–3 columns of portlets.
- **Consistency:** identical left-nav / right-detail model as the app shell, so Settings feels native to the
  desktop UI rather than a bolted-on tab strip.
- **Mobile:** the settings categories collapse back to the existing stacked/tab behavior (responsive) — the
  phone experience is unchanged.
- **Additive, not a rewrite:** reuse the existing `showSettingsTab` + settings render/save functions; the
  redesign is **layout + navigation chrome** (regrouping existing fields into portlets/columns), NOT new
  settings logic. Every existing setting and its save path is preserved (the regression guard below applies
  here too).

Settings-specific open items: confirm the full category list + which fields group into which portlet per
category; whether "Tools" in Settings overlaps the main-nav "Other tools" group or is settings-only.

## HARD REGRESSION GUARD (mandatory when this is built)
Per the code-gen regression-guard rule, this project's build prompt MUST open with a preservation inventory:
**every existing screen, nav path, and feature keeps working**; the desktop shell is **additive** (a new
frame + nav that calls the existing show/render functions). No screen logic rewritten, no mobile UI changed.
A regression on any existing screen blocks the merge. This is a 25k-line single file — the risk of "modernize
everything" drift is high; the guard is not optional.

## Open questions (answer at scheduling)
1. **Breakpoint** — where does desktop-shell kick in (e.g. >= 1024px)? Tablet behavior?
2. **Framework vs hand-rolled** — the app is vanilla HTML/CSS/JS, no framework/build (technology-selection
   rule). Do we hand-roll the shell in the same vanilla style (recommended — no build step to add), or is a
   framework finally justified? Default: hand-roll, matching existing CSS variables.
3. **"Disaster Recovery"** — what's in scope for this group (new feature vs a home for FW-58 outage mirror)?
4. **Routing / deep-linking** — stay with `hideAll()`/`show*` (no URL routing), or add hash-based routes so
   desktop nav is linkable/back-button-friendly?
5. **Account/settings menu** — exact contents (profile, subscription/billing, settings, org, sign out)?
6. **Single file vs. split** — does this finally warrant breaking `index.html` up, or stay one file? (CLAUDE.md
   currently mandates one file — this project could revisit that, deliberately.)

## First steps (when picked up)
1. Wireframe the desktop shell (left nav groups + top bar + content region) for owner approval — mock only.
2. Map every existing screen to a nav group; confirm the account-menu contents.
3. Write the build plan WITH the preservation inventory (regression guard) for owner sign-off.
4. Build the shell additively on dev behind the desktop breakpoint; verify every screen still reaches and
   renders; mobile UI byte-for-byte unchanged. Right-sized test script (**HIGH** — touches global layout/nav).

## Related
- Mobile-first / PWA note in `CLAUDE.md` (the constraint this respects on phones).
- `~/.claude/rules/code-gen-regression-guard.md` — the mandatory preservation-inventory pattern.
- Full-width desktop screens use the dispatch width mechanism (existing desktop-width groundwork).
- FW-66 Sales Workspace (Business Development group) · FW-58 outage mirror (candidate for Disaster Recovery).
