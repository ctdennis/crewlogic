# Plan — Caps, Roles & Enforcement (pre-billing build)

Status: IN PROGRESS. Execution detail for `plan-payments.md` §4.4. Companion strategy/decisions
live in `plan-payments.md` (§4, §7).

Progress:
- **Epic A DONE — LIVE IN PROD (v5.50.48).** Access = subscription_status only; provisionNative 'free'.
- **Epic B CANCELLED** (model change — no dispatch role).
- **Epic C DONE ON DEV (v5.50.50), Owner-verified ("looks good, exactly as expected").** Per-user tile
  toggles + owner editor + login read + showApp filter + trio layering fix. NOT yet promoted to prod
  (backfill runs at promotion). Ready to promote.
- **Epics C + D DONE — LIVE IN PROD (v5.50.56, 2026-07-11).** Migrations 0036-0039 applied to prod;
  live add-on secrets set; crewlogic-ai + crewlogic-billing deployed; frontend merged to main; estimator
  backfill (4 estimators × 6 tiles = 24 rows) so no downgrade; dev test rows cleaned. Verified prod
  usageSummary (#90 est 26/75, photos 46/1500). Estimate caps recalibrated 25/75/250.
  - Per-user tile toggles (C) · usage caps + 80/90/95% warnings + dormant ENFORCE_USAGE_CAPS gate ·
    seat add/remove (bidirectional, one combined charge) · overage buy→credit (one-month) all live.
  - **NOTE — add-on buttons take REAL money on prod now** (buyOverage/adjustSeats use LIVE prices).
    The SUBSCRIBE/paywall is still gated by BILLING_ENABLED (prod off). Decide: leave add-ons live for
    revenue, or gate them behind BILLING_ENABLED until Epic E.
- **Epic F DONE — LIVE on crewlogicai.com (2026-07-11).** Pricing section (3 tiers $29.99/$59.99/$129.99,
  recalibrated caps 25/75/250 est · 500/1500/5000 photos, seats 2/5/∞, $10 add-ons, transparency line) +
  nav Pricing link. Matches site design. Tweak on prod as needed.
- **Add-ons GATED on prod (v5.50.57)** behind BILLING_ENABLED until E.
- **Epic E DONE — BILLING LIVE IN PROD (v5.50.58, 2026-07-12).** BILLING_ENABLED on (subscribe paywall +
  add-ons live), ENFORCE_TRIAL on (soft-5-then-hard, grace 5d), pay-last checkout gate. Verified at flip:
  7 testers free, 2 on trial (Koby #56 + Eric #102, expire 2026-07-21 + grace → paywall ~7-26), 0 locked out.

## ROADMAP COMPLETE — A · C · D · F · E all in prod (B cancelled). 2026-07-12.
Open follow-ups (not blockers): flip ENFORCE_USAGE_CAPS to hard when comfortable · #56 Koby Linxup token
still a URL (0 stored) · reserved fast-follows (truck custom-label, crew role) · watch first live sub by ~7-26.
- Duplicate-franchise dedup: confirmed already handled (409 + UNIQUE(external_id)); pay-last checkout
  gate logged under Epic E.

## MODEL — REVISED & LOCKED (Owner 2026-07-11) — supersedes §4.1 of plan-payments.md

Owner simplified away the role-based billing entirely:
- **Billable unit = a user ID (headcount), NOT the estimator.** Every account counts toward the tier
  cap regardless of what they do. Owner chose headcount over metering-by-estimator for simplicity,
  knowing estimates drive the underlying cost.
- **Seat caps = TOTAL users incl. the owner:** Starter **2**, Pro **5**, Enterprise **∞** (unchanged
  numbers, now *users* not *estimators*). No free seats.
- **Exactly ONE admin per franchise = the owner.** Only the owner controls per-user tile assignment,
  billing, and settings. **No co-admin, no "dispatch role."** The son in the father/son case is a
  normal user with all tiles assigned; the father remains sole admin.
- **"Dispatch" and "Estimates" are TILES the owner assigns**, not roles. The existing `profiles.role`
  = `owner` (sole admin) vs `estimator` (a normal non-admin user) already models this — no new role.

### Impact on the epics below
- **Epic B (dispatch role): CANCELLED.** No 3rd role, no invite role-picker, no role gating. Keep
  owner/estimator as-is. The dev-only role CHECK (migration 0036) will be simplified to
  `owner/estimator` (drop the unused `dispatch`); it never reached prod.
- **Epic C (per-user tile toggles): now THE core access build.** Owner assigns each user's tiles via
  the `profile_feature_toggles` table. This IS the access model.
- **Epic D: seat enforcement = count user IDs (profiles) per franchise vs the tier cap** (2/5/∞ incl.
  owner). Photo/estimate *usage* caps (§7) still apply per franchise.
- Epics F (marketing pricing) and E (enable billing) unchanged.

Revised order: **C (tile toggles) → D (headcount + usage caps) → F (marketing) → E (enable billing).**

### Epic C — build detail (IN PROGRESS on dev)
- **Table `profile_feature_toggles`** (migration 0037) — DONE on dev. `(profile_id, feature_key,
  enabled)`, RLS permissive (matches existing anon team-mgmt posture; tiles aren't a security
  boundary — server enforces real access/caps).
- **12 tile keys:** estimates, volumeCheck, router, trucks, truckAlerts, disposalRouter, manageJobs,
  dashboard, estimatesDashboard, priceLookup, signs, jobPlan.
- **New-user default (Owner):** volumeCheck, priceLookup, manageJobs (applied in code when a profile
  has no toggle rows).
- **Visibility rule:** `capability-allowed(tile: CRM/telematics/desktop — unchanged) AND (owner OR
  toggle-on)`. Owner sees all. The existing role-only hiding of trucks/truckAlerts/router becomes
  owner-assignable via toggles.
- **REGRESSION-GUARD BACKFILL (Owner 2026-07-11, refined):** existing non-owner profiles get explicit
  ON toggles for the deliberate estimator set — **{estimates, volumeCheck, priceLookup, manageJobs,
  jobPlan, signs}**. Owner explicitly EXCLUDED dispatch/dashboard, estimatesDashboard/Estimates Desk,
  and disposalRouter/Job Router from estimators (even though a Vonigo+desktop estimator could see the
  first two today — intended). Yard signs is alpha but granted for now. Prod has 4 estimators to
  backfill (dev 0). Backfill SQL in migration 0037.

### Epic D — build detail (headcount seats + usage caps) — decisions Owner 2026-07-11
- **`tier_limits` table (pricing-in-DB):** tier → included_user_seats (Starter 2 / Pro 5 / Ent ∞),
  included_estimates (250/750/2500), included_photos (500/1500/5000), overage_block_price (10),
  overage_estimates (25), overage_photos (50), **additional_user_price (10 /user/mo)**.
- **Usage period = Stripe billing cycle** (current_period_start→end per franchise); trials = calendar month.
- **Seat model:** effective cap = included + purchased additional seats. Additional user = **$10/user/mo**
  as a Stripe subscription **quantity**, bidirectional + prorated: add over cap → qty+1 (+$10); remove →
  qty−1 (−$10). **Downgrade MUST drop the charge.** Owner counts toward included.
- **Usage counting (CONFIRMED Owner 2026-07-11, verified against usage_events):**
  - **Estimates cap** = COUNT of `ai.analyze_estimate` events. A **volume check is NOT an estimate.**
  - **Photos cap** = SUM(`metadata.images`) over **`ai.analyze_estimate` + `ai.volume_check`** (volume-check
    photos DO count — they cost the same). `ai.job_plan` touches neither cap.
- **FOLLOWUP (Owner 2026-07-11) — transparency:** make it *painfully clear* on BOTH the **app** (by the
  usage/allowance display) and the **marketing site** (pricing, Epic F) that (1) volume-check photos count
  toward the photo allowance, and (2) a volume check does NOT count as an estimate. Users must understand
  what burns their allowance. Tracked here; app copy in D, marketing copy in F.
- **Warnings 80/90/95%** on estimates AND photos.
- **Enforcement:** usage 100% → soft-block (5-day grace) → hard-block. Seat cap → **soft-block + flag** at
  launch.
- **Launch scope:** `tier_limits` + usage counting + 80/90/95% warnings + usage soft/hard block + seat
  soft-flag. **Fast-follow (same Stripe-add-on plumbing):** overage-block purchase ($10 = +25 est/+50
  photos, one-time top-up) + additional-user seat billing ($10/user/mo, add AND remove/downgrade).
- **Pricing:** additional_user_price = **$10/user/mo** (SET 2026-07-11). Overage block ~$10 (§7).

### Future / backlog (NOT now — Owner 2026-07-11)
- **Possible "crew" role** (or expand the per-tier user counts) for crew members who'd get a narrow
  set — price lookup, volume check, yard signs. Deferred; revisit after C/D/E ship.
- **Remaining (frontend/edge):** (1) buildSession nests `profile_feature_toggles(feature_key,enabled)`
  → `currentUser.tileToggles`; (2) showApp filters non-owner tiles by the toggle map (default set if
  none); (3) Team Members owner UI — per-user tile checklist + save via supabaseFetch upsert.
- **Cleanup:** simplify dev role CHECK (0036) to owner/estimator (drop unused 'dispatch').

Owner: Charles Dennis · Testers to onboard after this ships: **Koby (#56) + Eric Doherty**.

## Goal & guardrail

Everything below must be **built + on the marketing site BEFORE** we ask Koby/Eric to
subscribe (Owner directive 2026-07-10). `ENFORCE_TRIAL` = **soft for 5 days after expiry, then
hard** — the grace protects testers while this build lands. Enabling billing is the LAST step.

## Current-state facts (from code map 2026-07-11)

- Roles: `profiles.role` ∈ {owner, estimator}. Assembled in `buildSessionFromSupabaseAuth`
  (index.html ~5591); UI gated by `applyRoleRestrictions` (~7201) + `OWNER_ONLY` (~21959).
- Invite hard-codes `role:'estimator'` (index.html ~6563) — no picker.
- Home tiles: static `.module-card` HTML (index.html 1451-1524), shown/hidden imperatively in
  `showApp` (7368-7426) by role / CRM / franchise / telematics. **No entitlement/tier tile gating.**
- Entitlements: `currentUser` carries `subscriptionTier/Status/trialEndsAt` (~5626-5651).
  **No cap / quota / seat / limit field or check exists anywhere.**
- Metering: `usage_events` written by `_shared/usage.ts logUsage` (cols tenant_id, franchise_id,
  user_id, event_type, model, units, metadata). **Never counted for quota** — read only for cost.
- Billing: `ENFORCE_TRIAL=false` (~4173), `BILLING_ENABLED=IS_DEV_ENV` (~4179); Stripe
  checkout/portal/webhook + `#subscribeModal`/`#paywallScreen` already built, dormant on prod.

---

## Epics (ordered; each schema epic hits a contract-before-code gate)

### EPIC A — Subscription field hygiene (the 2 finishers) · size S · FOUNDATION
The gate cleanup so access = **status**, plan = **tier** (never conflated). Do first — B/C/D
gate on clean semantics.
- A1 (edge, 1 line): `_shared/provisionNative.ts:57` write `subscription_tier:'free'` not `null`.
- A2 (frontend): `buildSessionFromSupabaseAuth` ~5642 stop returning `subscription_tier` as an
  access grant; access derives from `subscription_status` only (`active/trialing/tester`).
- A3 (data): backfill any franchise using tier-as-access → set correct `subscription_status`.
- ⚠️ Tester-lockout risk (CLAUDE.md): enumerate testers, verify access BEFORE+AFTER. Grandfather.
- Gate: data/backfill = YELLOW. Ship behind a dev tester-access check.

### EPIC B — Dispatch-only role · size M
Third role: board/trucks/routes/job-plans, **cannot create estimates → free/unlimited**.
- **B0 — REGRESSION GUARD (Owner 2026-07-11):** this rollout MUST NOT change any existing
  `profiles.role`. Every current owner stays owner, every estimator stays estimator; `dispatch` is
  only ever assigned to NEW invites or an explicit owner change. Invite default = **Estimator** so
  no existing user's privileges are elevated by this push. No bulk role UPDATE, ever.
- B1 (data): allow `profiles.role='dispatch'`. Column is already text. **First enumerate existing
  distinct `role` values** (dev + prod, read-only) so a CHECK constraint permits every legacy value
  + `dispatch` and rejects nothing in use. Add CHECK only after that audit.
- B2 (frontend): invite UI (~6563) + Team Members — add **role picker** (Estimator vs Dispatch).
- B3 (frontend): extend `applyRoleRestrictions` (~7201) — dispatch hides estimator/volumeCheck/
  priceLookup tiles + blocks estimate creation; keeps dispatch tiles.
- B4 (frontend+edge): **seat counting** — estimators count vs tier cap (Starter 2/Pro 5/Ent ∞);
  dispatch uncounted. Soft-cap + ~2× hard ceiling (decided §1.7). Guard at invite time.
- Gate: role CHECK = YELLOW.

### EPIC C — Owner per-estimator feature toggles · size M
Owner turns home tiles on/off **per estimator**, within the tier ceiling.
- C1 (schema): **DECISION** — recommend a small table `profile_feature_toggles(profile_id,
  feature_key, enabled, updated_at)` (relational, per ask-before-json-blob) vs a JSONB
  `profiles.feature_toggles` blob. Lean: table.
- C2 (frontend): per-estimator toggle list in Team Members (only tiles the tier includes).
- C3 (frontend): `showApp` tile visibility = (tier ceiling) ∩ (owner toggle) ∩ (existing role/CRM
  gating). Owner always sees all.
- C4 (edge): save/read toggles (service-role or RLS-scoped).
- Gate: new table = YELLOW.

### EPIC D — Usage / seat cap enforcement · size L (biggest)
Caps enforced server-side off the `usage_events` backbone.
- D1 (schema, pricing-never-in-code): `tier_limits` table — tier, included_estimates,
  included_photos, overage_block_price, overage_estimates, overage_photos. Seed §7 caps
  (Starter 250/500 · Pro 750/1,500 · Ent 2,500/5,000; block ~$10 = +25 est/+50 photos).
  Per-franchise: billing-period anchor + purchased-overage counter.
- D2 (edge): count `usage_events` per franchise per period (estimates + photos) vs cap → an RPC/
  edge action returns usage+remaining.
- D3 (frontend): warning banners at **80/90/95%** on estimates AND photos.
- D4 (edge): enforcement point — `crewlogic-ai` analyze-estimate + photo upload check quota
  BEFORE running; at 100% soft-block (grace) → then hard-block OR require an overage block.
- D5 (frontend+Stripe): one-click buy an overage block (via `crewlogic-billing`).
- Gate: `tier_limits` + per-franchise counters = YELLOW; enforcement in AI path needs care (never
  suppress errors; safe error envelope).

### EPIC F — Marketing-site pricing · size M · PARALLEL
Source: **`marketing/index.html` in THIS repo** (deploys to crewlogicai.com; app = `index.html` →
app.crewlogicai.com). Structure: hero → how-it-works → features → `#trial` signup → footer. The
nav's "Pricing & Price Book" is the *price-book feature* page — **no subscription plans/pricing
section exists**. So F = **ADD** a Plans section (3 tier cards: Starter $29.99 / Pro $59.99 /
Enterprise $129.99 with caps, seats, dispatch-free, feature list) + a nav "Pricing" link, placed
between features (~197) and `#trial` (~231). Design pass on the tier cards; confirm the
crewlogicai.com deploy picks up `marketing/` on merge to main.

### EPIC E — Enable billing for testers · size S · LAST
After A–D built + F published + verified:
- E1: flip `BILLING_ENABLED` on prod; set `ENFORCE_TRIAL` = soft-5-days-then-hard.
- E2: stamp Koby (#56) + Eric Doherty `trial_ends_at`.
- E3: verify ONE real live subscription end-to-end (checkout → webhook → status flip → access).

#### E — HARD onboarding/checkout requirements (Owner 2026-07-11)
**Duplicate-franchise protection ALREADY EXISTS** and must not regress:
- App guard: `crewlogic-settings` Vonigo-connect returns **409 "already owned by another user"** when a
  franchise with the connecting user's Vonigo franchise ID already has a different owner (dedup key =
  Vonigo `Session.franchiseID` → `franchises.external_id`).
- DB backstop: `franchises_external_id_unique UNIQUE(external_id)` — VERIFIED live on prod.
- A @junkluggers.com Google sign-in creates a profile with `franchise_id = NULL` (Vonigo-pending); the
  franchise only materializes at Vonigo-connect, where the dedup fires. First to connect a given Vonigo
  ID wins; the second is blocked.

**PAY-LAST ordering (the actual requirement):** never charge a card before the franchise is established
and deduped, so a duplicate is blocked BEFORE payment (no refund mess).
- **Checkout gate:** for a Vonigo account, `startCheckout` MUST refuse until Vonigo is connected
  (franchise resolved). Force the skip-trial/pay-now path through Vonigo-connect first.
- Funnel: Google sign-in → **Connect Vonigo (dedup here, free)** → trial/use → **Subscribe (card, last)**.
- **Belt-and-suspenders:** wire a programmatic Stripe **auto-refund + sub-cancel** into any post-charge
  block path, so an accidental charge is a no-op instead of a manual refund.

**Onboarding polish (fold into E):**
- Improve the 409 message → "Franchise N is already set up by <owner>; ask them to invite you" + link the
  invite flow (don't dead-end).
- Clean up / convert the orphan NULL-franchise pending profile after a block.
- Formalize `UNIQUE(external_id)` as a numbered migration (currently baseline-snapshot only).

---

## Dependency order

```
A (hygiene) ─► B (dispatch role) ─► C (feature toggles) ─► D (enforcement) ─► E (enable billing)
                                                     F (marketing) runs parallel, must be done before E
```
A first (clean semantics). B before C (toggles read the role set). D is the long pole (start its
schema early). E strictly last. F any time, gates E.

## Decisions — RESOLVED (Owner 2026-07-11)

1. **Feature-toggle storage** (C1): **relational table** `profile_feature_toggles`. ✓
2. **Build cadence:** **one epic at a time**, checkpoint on dev after each. ✓
3. **Marketing site** (F): **`marketing/index.html` in this repo** — add a plans section. ✓
4. **Dispatch invite default** (B2): default **Estimator**, with a Dispatch option. ✓

## Already-decided (auto — no need to re-ask)
- Prices/caps/overage/warnings (§7). Seat model soft+hard ~2× (§1.7). Yard signs ungated now,
  add-on later w/ grandfather (§4.3). Testers = Koby + Eric. ENFORCE_TRIAL soft-5-then-hard.
