# Stripe Setup — CrewLogicAI Billing (round 1)

**Created:** 2026-06-24. How CrewLogic's Stripe billing is wired, and the repeatable steps to set it up
per environment. Round 1 = **one plan, $29.99/mo per franchise (location)**. Prices live in **Stripe**, never
in code (pricing-never-in-code).

## Architecture

- **Edge function `crewlogic-billing`** (`supabase/functions/crewlogic-billing/index.ts`):
  - `createCheckoutSession` → Stripe hosted Checkout for the $29.99 plan (frontend redirects to the returned URL).
  - `createPortalSession` → Stripe Customer Portal (update card / cancel). Wired to Settings → Account → **Manage billing**.
  - **Webhook** (signature-verified) → flips `franchises.subscription_status` + writes `stripe_*` columns on
    `checkout.session.completed` / `customer.subscription.updated` / `customer.subscription.deleted` / `invoice.payment_failed`.
- **Frontend** (`index.html`): paywall **Subscribe — $29.99/mo** → `startCheckout()`; Settings **Manage billing** →
  `openBillingPortal()`; both via `billingCall()` which sends the user's Supabase JWT so the fn resolves the caller's franchise.
- **DB** (migration `0025_stripe_billing.sql`): `stripe_customer_id`, `stripe_subscription_id`, `stripe_price_id`,
  `subscription_current_period_end` on `franchises`. The access gate reads **`franchise.subscription_status`** as
  authoritative (index.html `buildSessionFromSupabaseAuth`); the webhook sets it to `active` / `past_due` / `canceled`.

## Secrets (per Supabase project)

Three secrets, set on the Supabase project (Dashboard → Project → Settings → Edge Functions → Secrets, or
`supabase secrets set`). **Never** put live keys on dev, or any secret key in code/chat.

| Secret | Value | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` (dev) / `sk_live_…` (prod) | Stripe → Developers → API keys |
| `STRIPE_PRICE_ID` | `price_…` | the $29.99/mo recurring price (NOT the `prod_…` product id) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | the webhook endpoint's signing secret |

Projects: **dev = `crewlogic-dev`** (ref `bagkimfwmpwjfhfhmsrb`) · **prod = `crewlogic-prod`** (ref `ozfkpxyachigfpcmvekz`).
Function URL per env: `https://<project-ref>.supabase.co/functions/v1/crewlogic-billing`.

## Setup steps (repeat per environment — Test/Sandbox for dev, Live for prod)

1. **Stripe account / mode.** Dev uses a **Sandbox / Test mode**; prod uses **Live mode**. (Test keys start `sk_test_`/`pk_test_`.)
2. **"Who handles global sales?"** → choose **"I'll do it"** — NOT Stripe Managed Payments (that adds a **3.5%** MoR fee
   on top of the normal ~2.9%+30¢; only worth it for international/VAT, which we don't have). Add **Stripe Tax** later if US SaaS tax ever applies.
3. **Products to enable:** **Recurring payments** (required). Invoicing / Tax collection optional — they don't bill unless used.
4. **Create the plan:** Products → Add product → name `CrewLogic` → **recurring price $29.99/month** → save → copy the **Price ID** (`price_…`).
5. **API keys:** Developers → API keys → copy the **Secret key** (`sk_…`) (publishable key not needed for hosted Checkout).
6. **Set secrets** on the matching Supabase project: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`.
7. **Webhook:** Developers → **Webhooks / Event destinations** → Add endpoint:
   - URL: `https://<project-ref>.supabase.co/functions/v1/crewlogic-billing`
   - Scope: **Your account**; events: `checkout.session.completed`, `customer.subscription.updated`,
     `customer.subscription.deleted`, `invoice.payment_failed`
   - Save → copy the **Signing secret** (`whsec_…`) → set `STRIPE_WEBHOOK_SECRET`.
8. **Deploy the function:** `supabase functions deploy --project-ref <ref> crewlogic-billing --use-api --no-verify-jwt`
   (`--no-verify-jwt` so Stripe's unauthenticated webhook POST isn't platform-blocked; the fn does its own
   signature + caller-JWT checks).
9. **Verify:** `POST {action:"ping"}` → `hasPrice/hasSecret/hasWebhook` all true; `POST {action:"verify"}` →
   returns the price (`amount:2999, interval:month`). Then run a live test card (`4242 4242 4242 4242`) and confirm
   the webhook flips `subscription_status` to `active`.

## Prod cutover checklist (round 1 go-live — RED, owner-gated)

- [ ] Stripe **Live mode**: create `CrewLogic` product + $29.99/mo price; get **live** keys; register the **live** webhook (prod fn URL).
- [ ] Set `STRIPE_SECRET_KEY` (sk_live), `STRIPE_PRICE_ID` (live price_), `STRIPE_WEBHOOK_SECRET` (live whsec) on **crewlogic-prod**.
- [ ] Apply migration `0025` to prod (gated `supabase db`/SQL).
- [ ] Deploy `crewlogic-billing` to prod (`--use-api --no-verify-jwt`).
- [ ] **Audit prod franchise statuses** so flipping `ENFORCE_TRIAL=true` locks out no tester (never-lock-out-testers rule).
- [ ] Flip `ENFORCE_TRIAL=true` (index.html).
- [ ] Merge `dev`→`main` → Cloudflare serves `app.crewlogicai.com`.
- [ ] Live smoke: real card subscribe → access; Manage billing → portal; cancel → paywall.

## No follow-up actions tracked here
Operational reference. The round-1 task state lives in `.HUB/Hub.md` + `docs/plan-payments.md`.
