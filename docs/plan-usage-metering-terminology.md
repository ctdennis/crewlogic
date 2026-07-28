# Plan — Usage Metering + Terminology (Estimates vs AI Calls vs Photos)

Status: DRAFT — awaiting Owner decisions (see §9). No code until approved.
Owner: ctdennis · Drafted: 2026-07-27

## 1. Problem

The app meters **one** number and mislabels it. The home banner + pricing card say
"Estimates 60/25", but that 60 is actually **AI analyze calls** — one per room, plus every
re-run. An estimate is **1-to-many** with AI calls.

Evidence (franchise #116 / Meghan, July 2026, real prod data):

| Metric | Count |
|---|---|
| Estimates saved (distinct, `estimates` table, 0 deleted) | **9** |
| AI analyze calls (`ai.analyze_estimate` events) | **60** |
| Photos analyzed (Σ `metadata.images`) | **228** |
| Volume checks (`ai.volume_check`) | 2 |

→ **~7 AI calls per estimate.** A 20-room estimate alone can be ~20 calls. "60 estimates"
is a lie; she made **9**. The metering unit is right for *cost* (each call = one Anthropic
charge) but wrong for the *label* and wrong as the customer-facing "estimate" count.

## 2. The model (three separate metered dimensions, renamed honestly everywhere)

| Term | Definition | Notes |
|---|---|---|
| **Estimate** | One saved customer estimate (`estimates` row, not deleted) | 1 → many AI calls |
| **AI call** | One AI analysis of **one room**. "Analyze All" on N un-analyzed rooms = **N calls** (3 in parallel); already-analyzed rooms are **skipped** (not re-billed); a manual per-room re-analyze = **+1** each. Volume Check = +1. | the cost unit |
| **Photo** | One image UPLOADED to storage — counted on upload, not on analyze (a stored photo is a billable storage unit; volume-check photos aren't stored, so they don't count) | many per AI call |

Rename rule: **"estimate" never again means "AI call"** — in marketing, the pricing card,
the usage banner, tooltips, and error messages. The pricing card's "25 AI estimates/month"
becomes three lines: estimates / AI calls / photos.

## 3. Metering changes (how each dimension is counted, per period = calendar month)

- **Estimates** = COUNT of `estimates` rows for the franchise created in-period with
  `deleted_at IS NULL`. (New — today this number is not surfaced.) Re-analyzing an estimate
  does NOT increment it. Deleting an estimate DOES decrement it (soft-delete excluded).
- **AI calls** = COUNT of `ai.analyze_estimate` events in-period (today's mislabeled
  "estimates"). Owner decision §9-b: do Volume Checks count as AI calls?
- **Photos** = Σ `metadata.count` over `photo.upload` events — logged on each `estimate-photos`
  storage upload (`uploadPhotoToSupabase` → `crewlogic-ai` `logPhotoUpload`). Counted on UPLOAD
  (a stored photo is a billable storage unit), NOT per analyzed image; volume-check photos aren't
  stored so they don't count. (Owner 2026-07-28: photos are a storage charge, count on add.)

`_shared/usage.ts::countUsage` returns `{ estimates, aiCalls, photos }`; `usageSummary` +
`usageStatus` return all three with their caps.

## 4. Display — live, event-driven (NEW, from Owner 2026-07-27 screenshots)

Show all three counters (used / cap), live-ticking, in **two** places:

1. **Estimates list page** — a compact usage strip at the **top** (below the header).
2. **Estimate editor page** — the same strip at the **top** of each estimate.

"Ticks down on each event": the remaining count updates the instant an event fires, not only
on page load.
- **New estimate saved** → estimates −1.
- **AI call** (per-room analyze, or each room inside "Analyze All") → AI calls −1 each; e.g.
  Analyze-All on a 4-room estimate = −4 AI calls + the photos in those rooms.
- **Photo analyzed** → photos −N.

Mechanism: fetch the baseline from `usageSummary` on entry, then **optimistically decrement**
a shared client counter on each event for instant feedback, and re-sync with the server on a
light cadence + on screen enter (so the display is never wrong for long). One shared usage
module feeds both surfaces (reuse, not two copies).

## 5. Tiers + numbers (DB-driven — `tier_limits`, never in code)

`tier_limits` gains `included_ai_calls`. Owner fills the grid (§9-a). Current state for
reference (est cap is really the AI-call cap today):

| Tier | Estimates/mo | AI calls/mo | Photos/mo |
|---|---|---|---|
| Starter | 25 (Owner: 25) | ? (Owner floated 75 — but see ratio note) | 500 |
| Pro | ? | ? | 1,500 |
| Enterprise | ? | ? | 5,000 |

Ratio caveat: at ~7 calls/estimate, "25 estimates" ≈ ~175 AI calls, so an AI-call cap of 75
would bite at ~11 estimates. Set the two numbers consistently (or intend AI calls as the real
ceiling).

## 6. Increase / overage (Owner: "franchisee OR me on the backend")

- **Franchisee self-serve** — top up in-app. Owner decision §9-c: per-dimension top-ups
  (+estimates / +AI calls / +photos, priced each) or one combined block? Extends today's
  "Add credits" ($10 → +25 est/+50 photos).
- **Owner backend grant** — extend the super-admin **Subscription Management** console (today
  it only sets the trial clock) to grant extra of any dimension to a specific franchise, and
  to show each account's current usage vs cap (today it shows neither).

## 7. Enforcement

Stays OFF (`ENFORCE_USAGE_CAPS` unset) until Owner flips it. Owner decision §9-d: when on,
which dimension(s) hard-block — AI calls only (cost), or all three? Others stay advisory.

## 8. Build phases (dev-first, prod gated) — STATUS

1. ✅ **Contract** — captured in this doc (§3 metering shape, §6 overage/grant).
2. ✅ **Schema/migration** — migration 0075: `tier_limits.included_ai_calls` (75/225/750) +
   `franchises.overage_call_credit`. Applied dev.
3. ✅ **Metering** — `countUsage` → 3 dims (distinct estimates from `estimates`; AI calls =
   analyze + volume-check; photos); `usageSummary`/`usageStatus`. Deployed + smoked dev.
4. ✅ **Display** — shared usage module + strip on estimates list + editor, live tick-down on
   each analyze/volume-check (optimistic + 6s re-sync); home banner shows all 3, warns on
   AI calls + photos. v5.97.0.
5. ⏳ **Overage (franchisee self-serve)** — per §9-c per-dimension top-ups. NOT built — needs
   Owner overage pricing (per-dimension prices, or keep the current $10 combined block). The
   admin grant lever (phase 6) already covers "increase" in the meantime.
6. ✅ **Admin** — Subscription Management shows per-account usage + a Grant lever (est/AI calls/
   photos) → `grantUsage` op. v5.98.x.
7. ✅ **Terminology sweep** — marketing pricing cards now list estimates + AI calls + photos
   (was "AI estimates"); overage/fineprint relabeled. App side already correct (phase 4 labels;
   plan cards use feature names, not counts). Error copy is generic ("this month's allowance").
8. ⏳ **Enforcement** — behind `ENFORCE_USAGE_CAPS` (unset = OFF); targets AI calls + photos.
   Keep OFF until Owner flips it.

## 9. Decisions — RESOLVED (Owner 2026-07-27)

- **a. Numbers** — proceed with Owner's Starter (25 est / 75 AI calls / 500 photos); Pro/Ent
  seeded proportionally (see §5 grid) as DB values, tunable anytime. Not blocking (enforcement off).
- **b. Volume Checks count as AI calls** — YES. A volume check = 1 AI call + its photos; never an estimate.
- **c. Overage** — YES, per-dimension top-ups (buy +estimates / +AI calls / +photos separately).
- **d. Enforcement** — hard-block on **AI calls + photos** (the cost). **Estimates = advisory only.**

## 10. Related

- Rules: pricing-never-in-code (numbers in DB), contract-before-code (this doc first),
  actionable-docs-require-tracking (tracked in `.HUB/Hub.md`).
- Code: `_shared/usage.ts`, `crewlogic-ai` (`usageSummary`/`usageStatus`/`logUsage`),
  `tier_limits` table, `index.html` (`checkUsageWarnings`, estimates list, estimate editor,
  `showSubscriptionAdmin`), the pricing/marketing card.
