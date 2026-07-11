# Plan — Caps, Roles & Enforcement (pre-billing build)

Status: SCOPE for Owner review (2026-07-11). Nothing built yet. Execution detail for
`plan-payments.md` §4.4. Companion strategy/decisions live in `plan-payments.md` (§4, §7).

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
- B1 (data): allow `profiles.role='dispatch'` (column already text; document allowed values +
  a CHECK constraint). No table add.
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
