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

**Round 1 = the minimum to start charging:**
- **One launch plan at $29.99/mo per location** (matches QuoteIQ entry). Price lives in **Stripe**, not code.
- **No feature-gating** in round 1 — every paid account gets the current feature set.
- **Stripe self-serve:** Checkout (trial→paid off the existing `#paywallScreen`) + webhook→edge fn + Customer
  Portal + the 4 Stripe columns (migration **0025**, applied to dev 2026-06-24).
- **Flip `ENFORCE_TRIAL=true`** (index.html ~3855) so the 14-day trial actually gates after expiry.

**Deferred to round 2+ ("rapidly build"):** 3-tier matrix + feature-gating + seat enforcement (§1.7); the
**customer self-serve instant-quote widget** (the #1 QuoteIQ gap, and the horizontal wedge); **AI route-aware
scheduling**; **AI crew rotation/fairness staffing**; invoicing/marketing/reviews; multi-vertical templating.

§§1–7 below remain the fuller design that round 2 builds toward.

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

## 3. Tier matrix

Aligned to the actual home-page feature cards (2026-06-23). Two independent axes:
**(a) who can use it** — Native (non-Junkluggers) vs Junkluggers franchisee — and **(b) which tier
unlocks it**. They're orthogonal: e.g. Where Are My Trucks works for a native company (it's telematics,
not Vonigo) but is a Pro feature, so a native company would upgrade to Pro to get it.

**Tier attributes** (numbers are placeholders — sized from prod metering before launch):

| | **Starter** | **Pro** *(most popular)* | **Enterprise** |
|---|---|---|---|
| Target | small / independent (native funnel) | established single location | multi-location / group |
| Seats (estimators) | 2 | 5 | unlimited |
| Seat enforcement | soft + hard ceiling (~2×) | soft + hard ceiling (~2×) | n/a |
| AI estimates / mo (soft cap) | ~50 | ~250 | custom |
| Support | email | priority | dedicated |

**Feature matrix** (home-page cards; "Native" = usable by a non-Junkluggers company, "JL" = Junkluggers franchisee):

| Feature (home card) | Native | JL | Starter | Pro | Enterprise |
|---|---|---|---|---|---|
| 📝 Estimates | ✓ | ✓ | ✓ | ✓ | ✓ |
| 📐 Volume Check | ✓ | ✓ | ✓ | ✓ | ✓ |
| 💲 Price Lookup | ✓ | ✓ | ✓ | ✓ | ✓ |
| 🪧 Yard Signs | ✓ | ✓ | ✓ | ✓ | ✓ |
| 🚚 Where Are My Trucks? | ✓ | ✓ | — | ✓ | ✓ |
| 📋 Job Plan (AI brief) | — | ✓ | — | ✓ | ✓ |
| 🎤 Manage Jobs (voice dispatcher) | — | ✓ | — | ✓ | ✓ |
| ♻️ Job Router (disposal recommender) | —¹ | ✓ | — | ✓ | ✓ |
| 🔌 Vonigo / CRM connect | — | ✓ | — | ✓ | ✓ |
| 🏢 National Accounts | — | ✓ | — | — | ✓ |

**Telematics = Motive AND LinxUp** — Where Are My Trucks supports both providers (per-franchise creds),
and is independent of Vonigo, so it's available to native companies too (gated to Pro by tier).

¹ **Job Router is JL-only today** because its "next job" comes from the Vonigo schedule (native has no
in-app schedule yet); it can extend to native if native scheduling ships.

**National Accounts** = a Junkluggers feature for corporate/commercial accounts (Rubicon, Relocation
Remedies, SLM, …). It AI-simplifies each account's verbose per-customer crew "warning message" into a short
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
