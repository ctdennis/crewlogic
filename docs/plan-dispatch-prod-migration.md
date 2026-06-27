# Plan — Dispatch Dashboard + Trucks/Scheduling → Production Migration

**Status:** DRAFT for Owner approval (2026-06-27). No prod action until approved.
**Promotes:** `dev` (frontend **v5.47.58**) → `main` (currently **v5.47.12**) + the `crewlogic-dispatch` edge function.
**Scope is bounded:** since v5.47.12, only **two artifacts changed** — `index.html` and the
`crewlogic-dispatch` edge function. **No DB migrations.** (Verified `git diff origin/main..dev`.)

---

## What ships (52 commits, v5.47.13 → v5.47.58)

- **Desktop Dispatch dashboard** (`dashboardScreen`, gated to Vonigo franchises on width ≥ 1024): two
  route-aligned schedule boards (source + destination day) + the live trucks map below, mic/command toolbar.
- **Cross-day move** — drag-to-slot **and** voice/text command, both through one source→destination confirm
  modal (reuses the proven lock→WorkOrders method-16 engine).
- **Duration change** — tap-select buttons (mobile + desktop) + desktop right-edge drag handle (two-step
  staged resize engine).
- **Schedule board upgrades** (Manage Jobs + dashboard): all active routes in Vonigo **`sequence` order**,
  3-layer availability grid, time axis spanning the franchise's route hours, uniform labels, job **total ($)**
  + **💬 Text (SMS)** in the hover/tap tooltip, timeline auto-centered on "now" (Manage Jobs only).
- **Where Are My Trucks**: arrow/heading markers, per-franchise telematics, job markers with total + Text +
  hover-open + measure-distance (incl. mobile fixes), Today/Tomorrow + "+3 days" + Refresh controls.
- **Clickable addresses → Google Maps directions** across trucks + scheduling (matches estimates).

---

## Pre-flight checks (run at migration time; read-only)

1. **Prod `crewlogic-dispatch` is STALE** — confirmed: prod has `boardGrid` but the old objectID route
   order (MA1REG-first), missing sequence-order, route-hours axis, price-in-jobs, and duration-engine
   updates. → It MUST be redeployed.
2. **`dispatch_audit` table on prod** (migration 0024) — the move/cancel/duration audit log. Audit writes
   are best-effort (won't block a move), but confirm the table exists so the log records. If missing, apply 0024.
3. **Prod secrets present** (set during the v5.47.12 rollout — verify, don't re-set):
   - Vonigo Vault credentials for franchise 90 (board, move, duration, measure all auth to Vonigo).
   - `MOTIVE_API_KEY` (trucks map for #90).
   - Google Maps key for `crewlogic-estimate` `pointDistance` (measure-distance drive time).
   - `ANTHROPIC_API_KEY` (voice/command AI).
4. **Gating confirms** (no surprise exposure): dashboard card shows only when `_vonigoDash` && width ≥ 1024;
   board/trucks features are Vonigo-franchise scoped. Non-Vonigo / mobile users are unaffected.

---

## Migration steps (ordered; ⛔ = gated, needs explicit Owner go)

1. **Pre-flight** — run the read-only checks above; resolve any gap (e.g., apply 0024 if missing).
2. **⛔ Deploy `crewlogic-dispatch` to PROD** — `supabase functions deploy --project-ref ozfkpxyachigfpcmvekz crewlogic-dispatch`.
   - Safe ordering rationale: the new function is **additive** (new `boardGrid`/duration paths) and leaves the
     existing actions the live v5.47.12 frontend uses (`listRouteJobs`, `command`, `execute` move) unchanged —
     so deploying it BEFORE the frontend can't break current prod.
3. **Verify prod function** — prod `boardGrid` returns sequence order (EST first) + `boardStartMin/EndMin`;
   `listRouteJobs` still works (current board path).
4. **⛔ Merge `dev → main`** — `git checkout main && git merge --ff-only dev && git push origin main`
   (RED action). Cloudflare auto-deploys v5.47.58 to `app.crewlogicai.com` / `crewlogicai.com` (~1–2 min).
   Monitor the Pages build.
5. **Post-deploy E2E on prod** — the checklist below; iterate until green (per iterate-until-success).

---

## Post-deploy E2E checklist (prod, #90)

- [ ] Manage Jobs board: 8 active routes in sequence order, 3-layer grid, timeline centered on now, hover/tap tooltip shows total + 💬 Text + clickable Street.
- [ ] Dispatch dashboard (desktop ≥1024): two aligned boards + live trucks map full-width; date change updates one board (no full reflow).
- [ ] Cross-day move: drag a (test) job to a slot → confirm modal → moves in Vonigo + boards refresh.
- [ ] Voice/text command move: "move … to tomorrow at 10" → confirm modal (day-match rule) → moves.
- [ ] Duration change: tap-select (mobile) + drag-handle (desktop) → styled confirm → applies.
- [ ] Where Are My Trucks: trucks render; Today/Tomorrow + "+3 days" + Refresh; measure truck→job shows line + drive time (mobile + desktop).
- [ ] Addresses clickable → Google Maps directions across both features.
- [ ] Regression: estimates, price lookup, job plan, signs, auth/paywall, testers still work.

---

## Rollback

- **Frontend:** `git revert` the merge (or reset main to v5.47.12) → push → Cloudflare redeploys v5.47.12.
- **Function:** redeploy the prior `crewlogic-dispatch` to prod (`supabase functions download` the main-tagged
  copy, or deploy from a v5.47.12 checkout). Because the new fn is additive, frontend rollback alone restores
  prior behavior even if the fn stays.
- Trigger: any failed E2E item that affects live customer use. Roll back, fix on dev, re-migrate.

---

## Risk

- **Blast radius:** customer-facing (#90 owners/estimators). Mitigated by additive function + gated, scoped UI.
- **Vonigo writes** (move/duration) hit live appointments — E2E uses a bogus/test job before declaring green.
- **No schema change** → no migration risk; rollback is just frontend + (optional) function revert.

_Origin: Owner request 2026-06-27 to plan the production migration of the dispatch/trucks/scheduling work
built + validated on dev this session. Closes once migrated + E2E green._
