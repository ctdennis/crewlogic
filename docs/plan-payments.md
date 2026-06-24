# Payments + Pricing Plan

**Status:** Draft for owner approval · **Started:** 2026-06-16 · **Updated:** 2026-06-18
**Owner:** charles.dennis@junkluggers.com

Get CrewLogicAI ready to **accept card transactions** and ship a **pricing model** priced
against cost-to-serve. This doc is the approval artifact; no Stripe code lands until it's approved.

---

## 0. ROUND 1 — launch scope (decided 2026-06-24)

**Strategy shift (owner):** the franchise market is small (~100 Junkluggers); the real opportunity is the
**thousands of independent blue-collar businesses** needing a quoting engine. CrewLogic goes **horizontal**
(the brand/engine travel; junk is the beachhead). Caveat from `competitive-landscape.md`: **QuoteIQ is already a
horizontal "Contractor CRM"** — so the edge is **ops/labor depth** (AI route-aware scheduling, crew
rotation/fairness — see `feature-grid-vs-quoteiq.md`), not breadth. Play = **ship round 1 fast, then rapidly
build shortfalls + value-adds** to get a foothold before the coming micro-app wave (~3–6 mo).

**Billing infra (DONE, dormant in prod 2026-06-24):** Stripe self-serve Checkout + webhook→edge fn + Customer
Portal + the 4 Stripe columns (migration 0025); `crewlogic-billing` deployed to prod inert; frontend behind the
`BILLING_ENABLED` master switch (prod OFF). See `docs/stripe-setup.md`.

**SCOPE CHANGE (owner 2026-06-24): gate features BEFORE release.** Round 1 is NOT a single ungated plan — launch
ships the FINAL tier grid (§3). The gate is one line: **native (Starter, $29.99) vs Vonigo (Pro, $TBD)**;
**Enterprise = scale** (same features as Pro, higher limits — features get "loaded up" later as we build).
So the **pre-release build** now includes feature-gating:
- **Feature-gating by `subscription_tier`** — Starter unlocks the standalone tools; Pro unlocks the Vonigo/ops
  features (+ the National Accounts Settings toggle).
- **Stripe prices per offered tier** (Starter $29.99 set; Pro $TBD) + a tier picker on the paywall.
- **Seat + AI-estimate soft caps** per tier (§1.7); photo-storage cap for Enterprise scaling.
- Then flip `ENFORCE_TRIAL=true` + `BILLING_ENABLED=true` to go live.

**Strategic priority (owner 2026-06-24): PARITY WITH QUOTEIQ.** After gating, the build order is closing the
QuoteIQ feature gaps (`competitive-landscape.md` §7 / `feature-grid-vs-quoteiq.md`) — #1 = **customer self-serve
instant quote**, then booking / invoicing-payments / reviews / CRM as warranted — plus the ops/labor
differentiators (AI scheduling, crew rotation). New features later "load up" the **Enterprise** tier.

§§1–7 below are the fuller design the build executes toward.

---

## 1. Locked decisions (owner)

1. **Billing unit = franchise location** (matches the schema's billing entity).
2. **Model = 3 tiers** (Starter / Pro / Enterprise), **advanced features gated by tier**, plus a
   **per-tier AI-estimate allowance** (the allowance ties price to the #1 marginal cost).
3. **Price against cost-to-serve** (value-based; no known market comp).
4. **AI overage (v1) = soft cap + upgrade nudge** — never block a crew mid-job; metered overage later.
5. **Prices (dollars) are NOT in this doc** — they live in DB / Stripe per the pricing-never-in-code
   rule. This doc locks the *structure* + a target margin; owner sets dollars in DB/Stripe.
6. **Processor = Stripe** (decided 2026-06-23). Rationale: hosted Checkout + Customer Portal = least
   code + PCI offloaded, and first-class subscription/trial/proration/usage billing. Owner uses **STAX**
   (Junkluggers operating payments) and has used **Authorize.net** (cheaper per-txn) — those win on fee
   for high-volume *customer* charges, but at SaaS volume (few franchises, recurring) the fee delta is a
   few $/mo and is dwarfed by Stripe's build/compliance savings. Revisit only if CrewLogic ever processes
   high volume. STAX/Authorize.net stay on operating payments.
7. **Seats: Starter 2 · Pro 5 · Enterprise unlimited** (decided 2026-06-23). **Enforcement v1 = soft cap
   + generous hard ceiling**: at/under count = normal; over count, under ceiling (~2× tier) = add freely +
   nudge + owner upsell flag; at ceiling = block (abuse guard). **Time-locked temp seats (5-day auto-expire)
   = v2 candidate** — deferred because it needs per-franchise temp-seat-day accounting / churn probe to stop
   create-delete gaming; build that in from the start when real demand appears, don't bolt it on.

---

## 2. Cost-to-serve anchor (from #90 metering)

- **AI vision is the dominant variable cost.** ~2.3K base tokens + ~1.5K/photo on Sonnet →
  roughly **$0.10–0.13 per photo-estimate**; ~$2–3/franchise/mo at ~24 estimates.
- Secondary: Google Maps (Street View / Distance Matrix / Geocoding per estimate; job-map
  geocoding is FREE US-Census) > Supabase Storage+egress (photos, grows) > compute/edge > Resend/n8n.
- **Implication:** AI is cheap enough that **price floors are set by product value, not the AI bill.**
  The AI allowance is mostly an abuse/runaway guard + an upsell lever, not a cost-recovery gate.
- AI-allowance sizing will be finalized from **prod metering** (`usage_events`, live since 2026-06-16)
  once ~1 week of multi-franchise data exists.

---

## 3. Tier matrix — FINAL (locked 2026-06-24)

**The feature gate is ONE line: native (Starter) vs Vonigo (Pro+).** Starter = the standalone AI-estimating
tools (no Vonigo); Pro = those PLUS every Vonigo/telematics ops feature. **Enterprise is a SCALE tier, not a
feature tier** — identical features to Pro, differentiated only by higher LIMITS (seats, AI estimates, photo
storage) + dedicated support, priced on volume. Second axis: **Native** (a non-Junkluggers company) can use the
Starter set + telematics; Vonigo features require a Junkluggers/Vonigo connection.

**Feature matrix** (built features; Pro & Enterprise share ALL features):

| Feature (home card) | Native | Starter | Pro | Enterprise |
|---|---|---|---|---|
| 📝 Estimates (AI photo→price, editor, PDF) | ✓ | ✓ | ✓ | ✓ |
| 📐 Volume Check | ✓ | ✓ | ✓ | ✓ |
| 💲 Price Lookup | ✓ | ✓ | ✓ | ✓ |
| 🪧 Yard Signs | ✓ | ✓ | ✓ | ✓ |
| 🔌 Vonigo / CRM connect | — | — | ✓ | ✓ |
| 🎤 Manage Jobs (voice dispatcher) | — | — | ✓ | ✓ |
| 📋 Job Plan (AI brief) | — | — | ✓ | ✓ |
| ♻️ Job Router (disposal recommender) | —¹ | — | ✓ | ✓ |
| 🚚 Where Are My Trucks? (telematics) | ✓² | — | ✓ | ✓ |
| 🏢 National Accounts (Settings on/off toggle) | — | — | ✓ | ✓ |

**Tier attributes** — the **Pro→Enterprise differentiator is SCALE** (numbers placeholders, sized from metering):

| | **Starter** | **Pro** *(most popular)* | **Enterprise** |
|---|---|---|---|
| Target | small / independent (native) | established single location | high-volume / multi-location |
| Feature set | standalone tools | full (Vonigo + ops + NA) | **same as Pro** |
| Seats (estimators) | 2 | 5 | unlimited / custom |
| AI estimates / mo (soft cap) | ~50 | ~250 | custom (high) |
| Photo storage | Starter cap | Pro cap | custom (high) |
| Support | email | priority | dedicated |
| Price/mo (per location) | **$29.99** | TBD | custom (volume) |

¹ **Job Router is JL-only today** (its "next job" comes from the Vonigo schedule; native has no in-app schedule yet).
² **Where Are My Trucks** is telematics (Motive AND LinxUp), independent of Vonigo — native-capable, but a Pro
feature (so a native co. wanting it would be on Pro). The one feature that's native-capable yet Pro-gated.

¹ **Job Router is JL-only today** because its "next job" comes from the Vonigo schedule (native has no
in-app schedule yet); it can extend to native if native scheduling ships.

**National Accounts** = a **Pro+ feature with a Settings on/off toggle** (owner 2026-06-24: a nice-to-have, not
a tier-pusher — so it lives in the Vonigo tiers, NOT gated to Enterprise). For Junkluggers corporate/commercial
accounts (Rubicon, Relocation Remedies, SLM, …). It AI-simplifies each account's verbose per-customer crew "warning message" into a short
⚠️/✅ on-the-job checklist (≤60 words) and writes it to the job's Summary so crews see concise, account-
specific instructions in Vonigo. **Trigger (owner-decided 2026-06-23): a nightly cron that sweeps the next
day's National-Accounts bookings and stamps the slimmed message onto each.** Research done; not built. See
Hub row + Vonigo write findings (Job field 978 Summary, Client field 9059 warning, service-type 27).

**States are NOT tiers:** `Trial` (14-day, marketing/self-serve) and `Tester` (internal,
non-expiring) live in `subscription_status`, not `subscription_tier`.

**Route Optimizer is roadmap, not a launch feature** (left off the matrix) — it is single-tenant
(#90-only, n8n + owner's Google Sheet) and needs a full re-architecture first. See the Hub row +
memory `route-optimizer-rearchitecture`.

---

## 4. Subscription field model (clean separation)

- **Access state → `subscription_status`** (`trialing / active / tester / canceled / past_due`),
  tenant- or franchise-level; franchise-level is authoritative when set.
- **Product plan → `subscription_tier`** (`free / pro / enterprise`). `free` = no paid plan.
- `'tester'` is a *state*, not a plan (normalized in prod 2026-06-18: tester-tier franchises → `free`).

**Two finishers to land with this work:**
1. **Gate cleanup** — `buildSessionFromSupabaseAuth` (index.html ~4935) must stop reading
   `subscription_tier` as an access grant, so a future **canceled `pro`** can't keep access via tier.
2. **Provisioning consistency** — `_shared/provisionNative.ts` writes `subscription_tier=null`;
   write `'free'` instead so `null` and `free` don't both mean "no plan."

---

## 5. Stripe plumbing (greenfield — no payment code today)

- **Stripe Checkout** — trial → paid from the existing `#paywallScreen`.
- **Webhook → edge function** — flips `subscription_status` / `subscription_tier` on
  pay / cancel / fail (`checkout.session.completed`, `customer.subscription.updated/deleted`,
  `invoice.payment_failed`).
- **Customer Portal** — self-serve card update / cancel.
- **`franchises.stripe_customer_id`** (+ migration).
- **Price IDs stored in DB / Stripe, never in code** (pricing-never-in-code). Tier → price-ID map
  resolved at runtime.
- **Feature-gating** reads `subscription_tier` from the session; **AI allowance** enforced server-side
  off `usage_events` (the metering backbone is already live).

---

## 6. Build sequence (after approval — contract-before-code gates)

1. **This plan** approved.
2. **Schema** — `stripe_customer_id`, any allowance/limit columns (limits as DB values, not code).
3. **Migrations PR** (SQL only).
4. **Feature-gating + soft-cap enforcement** (reads tier + usage; the 2 finishers from §4).
5. **Stripe Checkout + webhook + Portal** edge functions.
6. **Smoke tests** (real Stripe test mode + real DB) → dev verify → promote.

---

## 7. Open items

- [ ] Owner sets actual **prices** (DB/Stripe) + final **AI allowance** numbers (size from metering). *(still open — owner)*
- [x] Seat enforcement model — **decided 2026-06-23: soft + hard ceiling; counts 2/5/∞** (see §1.7). Time-lock temp seat = v2.
- [x] Processor — **decided 2026-06-23: Stripe** (see §1.6).
- [ ] Stripe account / API keys (test + live) provisioned (secrets gated). *(owner action when ready)*
- [ ] Route Optimizer re-architecture is a **separate project** (own Hub row), not part of this.
