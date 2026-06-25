// Supabase Edge Function: crewlogic-billing (round 1 — Stripe self-serve subscriptions)
// Deploy: supabase functions deploy crewlogic-billing
//
// Round-1 monetization: ONE plan ($29.99/mo per franchise/location). Price lives in Stripe
// (STRIPE_PRICE_ID), never hardcoded. Three jobs:
//   action:'createCheckoutSession' {returnUrl}  -> Stripe Checkout URL (trial -> paid from the paywall)
//   action:'createPortalSession'   {returnUrl}  -> Stripe Customer Portal URL (self-serve manage/cancel)
//   (Stripe webhook POST, has `stripe-signature` header) -> flips franchises.subscription_status + stripe_* cols
//
// Caller (checkout/portal) is identified from their Supabase Auth Bearer token -> profile -> franchise,
// so a caller can only act on their OWN franchise (client-supplied IDs are NOT trusted).
//
// SECRETS REQUIRED:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY  (auto-populated)
//   STRIPE_SECRET_KEY        (sk_test_… in dev, sk_live_… in prod)
//   STRIPE_PRICE_ID          (price_… for the $29.99/mo plan)
//   STRIPE_WEBHOOK_SECRET    (whsec_… from the Stripe webhook endpoint)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
// Tier → Stripe price id. Starter falls back to the legacy STRIPE_PRICE_ID for back-compat.
const STRIPE_PRICE: Record<string, string> = {
  starter: Deno.env.get("STRIPE_PRICE_STARTER") || Deno.env.get("STRIPE_PRICE_ID") || "",
  pro: Deno.env.get("STRIPE_PRICE_PRO") || "",
  enterprise: Deno.env.get("STRIPE_PRICE_ENTERPRISE") || "",
};
function priceForTier(tier: unknown): string {
  const t = String(tier || "starter").toLowerCase();
  return STRIPE_PRICE[t] || STRIPE_PRICE.starter;
}
// Reverse map (price id → tier) so the webhook can set franchises.subscription_tier from the paid price.
function tierForPrice(priceId: string): string | null {
  for (const t of ["starter", "pro", "enterprise"]) if (STRIPE_PRICE[t] && STRIPE_PRICE[t] === priceId) return t;
  return null;
}
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";

// Lazy init: don't construct Stripe at module load (an empty STRIPE_SECRET_KEY throws and kills the
// worker for ALL requests incl. ping). Build on first use; missing key -> caught -> safe 500.
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY not set");
  if (!_stripe) _stripe = new Stripe(STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
  return _stripe;
}
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// ── Supabase REST helpers (service role bypasses RLS) ──
async function sbGet(path: string): Promise<any[]> {
  const res = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} -> ${res.status}`);
  return res.json();
}
async function sbPatch(path: string, body: unknown): Promise<void> {
  const res = await fetch(SUPABASE_URL + path, {
    method: "PATCH",
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`Supabase PATCH ${path} -> ${res.status} ${t}`); }
}

type Franchise = { id: string; external_id: string | null; tenant_id: string; stripe_customer_id: string | null };

// Resolve the caller's OWN franchise from their Supabase Auth token (never trust client IDs).
async function franchiseForCaller(token: string | null): Promise<{ franchise: Franchise; email: string } | null> {
  if (!token) return null;
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: { user }, error } = await anon.auth.getUser(token);
  if (error || !user) return null;
  const profs = await sbGet(`/rest/v1/profiles?auth_user_id=eq.${encodeURIComponent(user.id)}&select=franchise_id`);
  const fid = profs[0]?.franchise_id;
  if (!fid) return null;
  const fr = await sbGet(`/rest/v1/franchises?id=eq.${encodeURIComponent(fid)}&select=id,external_id,tenant_id,stripe_customer_id`);
  if (!fr[0]) return null;
  return { franchise: fr[0] as Franchise, email: user.email || "" };
}

async function ensureCustomer(fr: Franchise, email: string): Promise<string> {
  if (fr.stripe_customer_id) return fr.stripe_customer_id;
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: email || undefined,
    metadata: { franchise_id: fr.id, external_id: fr.external_id || "", tenant_id: fr.tenant_id },
  });
  await sbPatch(`/rest/v1/franchises?id=eq.${encodeURIComponent(fr.id)}`, { stripe_customer_id: customer.id });
  return customer.id;
}

// Map a Stripe subscription status to our access-gate subscription_status.
function mapStatus(s: string): string {
  if (s === "active" || s === "trialing") return "active";
  if (s === "past_due" || s === "unpaid") return "past_due";
  return "canceled"; // canceled, incomplete_expired, paused, etc.
}
const isoOrNull = (unixSec: number | null | undefined) =>
  unixSec ? new Date(unixSec * 1000).toISOString() : null;

async function franchiseIdForEvent(obj: any): Promise<string | null> {
  const metaId = obj?.metadata?.franchise_id;
  if (metaId) return metaId;
  const cust = typeof obj?.customer === "string" ? obj.customer : obj?.customer?.id;
  if (cust) {
    const rows = await sbGet(`/rest/v1/franchises?stripe_customer_id=eq.${encodeURIComponent(cust)}&select=id`);
    if (rows[0]) return rows[0].id;
  }
  return null;
}

async function handleWebhook(req: Request): Promise<Response> {
  const sig = req.headers.get("stripe-signature");
  const raw = await req.text();
  if (!sig || !STRIPE_WEBHOOK_SECRET) return json({ error: "missing signature/secret" }, 400);
  let stripe: Stripe;
  try { stripe = getStripe(); } catch { console.error("[billing] webhook: STRIPE_SECRET_KEY not set"); return json({ error: "billing not configured" }, 500); }
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, STRIPE_WEBHOOK_SECRET, undefined, cryptoProvider);
  } catch (e) {
    console.error("[billing] webhook signature verification failed:", (e as Error).message);
    return json({ error: "invalid signature" }, 400);
  }
  try {
    const obj: any = event.data.object;
    if (event.type === "checkout.session.completed") {
      const fid = await franchiseIdForEvent(obj);
      const subId = typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id;
      let priceId: string | null = null, periodEnd: number | null = null;
      if (subId) {
        const sub = await stripe.subscriptions.retrieve(subId);
        priceId = sub.items.data[0]?.price?.id || null;
        periodEnd = (sub as any).current_period_end || null;
      }
      const tier = tierForPrice(priceId || "") || (obj.metadata?.tier ? String(obj.metadata.tier) : null);
      if (fid) await sbPatch(`/rest/v1/franchises?id=eq.${encodeURIComponent(fid)}`, {
        subscription_status: "active", stripe_subscription_id: subId || null,
        stripe_customer_id: typeof obj.customer === "string" ? obj.customer : obj.customer?.id,
        stripe_price_id: priceId, subscription_current_period_end: isoOrNull(periodEnd),
        ...(tier ? { subscription_tier: tier } : {}),
      });
    } else if (event.type === "customer.subscription.updated") {
      const fid = await franchiseIdForEvent(obj);
      const upPrice = obj.items?.data?.[0]?.price?.id || null;
      const upTier = tierForPrice(upPrice || "");
      if (fid) await sbPatch(`/rest/v1/franchises?id=eq.${encodeURIComponent(fid)}`, {
        subscription_status: mapStatus(obj.status), stripe_subscription_id: obj.id,
        stripe_price_id: upPrice, subscription_current_period_end: isoOrNull(obj.current_period_end),
        ...(upTier ? { subscription_tier: upTier } : {}),
      });
    } else if (event.type === "customer.subscription.deleted") {
      const fid = await franchiseIdForEvent(obj);
      if (fid) await sbPatch(`/rest/v1/franchises?id=eq.${encodeURIComponent(fid)}`, {
        subscription_status: "canceled", stripe_subscription_id: null, subscription_tier: "free",
      });
    } else if (event.type === "invoice.payment_failed") {
      const fid = await franchiseIdForEvent(obj);
      if (fid) await sbPatch(`/rest/v1/franchises?id=eq.${encodeURIComponent(fid)}`, { subscription_status: "past_due" });
    }
  } catch (e) {
    console.error("[billing] webhook handler error:", (e as Error).message);
    return json({ error: "handler error" }, 500); // 5xx -> Stripe retries
  }
  return json({ received: true });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Stripe webhook (no action; carries a signature header)
  if (req.headers.get("stripe-signature")) return handleWebhook(req);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = String(body.action || "");
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "") || null;
  const returnUrl = String(body.returnUrl || "").slice(0, 500);

  try {
    if (action === "ping") return json({ ok: true, hasSecret: !!STRIPE_SECRET_KEY, hasWebhook: !!STRIPE_WEBHOOK_SECRET, prices: { starter: !!STRIPE_PRICE.starter, pro: !!STRIPE_PRICE.pro, enterprise: !!STRIPE_PRICE.enterprise } });

    // Temp dev diagnostic: validates the secret key + that a tier price resolves (default starter).
    if (action === "verify") {
      try {
        const p = await getStripe().prices.retrieve(priceForTier(body.tier));
        return json({ ok: true, amount: p.unit_amount, currency: p.currency, interval: p.recurring?.interval, active: p.active });
      } catch (e) {
        console.error("[billing] verify failed:", (e as Error).message);
        return json({ ok: false, reason: (e as Error).message.slice(0, 120) });
      }
    }

    if (action === "createCheckoutSession" || action === "createPortalSession") {
      const who = await franchiseForCaller(token);
      if (!who) return json({ error: "Please sign in again." }, 401);
      if (!returnUrl) return json({ error: "returnUrl required" }, 400);
      const stripe = getStripe();

      if (action === "createPortalSession") {
        if (!who.franchise.stripe_customer_id) return json({ error: "No subscription on file yet." }, 400);
        const ps = await stripe.billingPortal.sessions.create({ customer: who.franchise.stripe_customer_id, return_url: returnUrl });
        return json({ url: ps.url });
      }

      const tier = String(body.tier || "starter").toLowerCase();
      const priceId = priceForTier(tier);
      if (!priceId) { console.error(`[billing] no price for tier ${tier}`); return json({ error: "Billing isn’t configured yet." }, 500); }
      const customer = await ensureCustomer(who.franchise, who.email);
      const meta = { franchise_id: who.franchise.id, external_id: who.franchise.external_id || "", tenant_id: who.franchise.tenant_id, tier };
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: returnUrl + (returnUrl.includes("?") ? "&" : "?") + "billing=success",
        cancel_url: returnUrl + (returnUrl.includes("?") ? "&" : "?") + "billing=cancel",
        allow_promotion_codes: true,
        metadata: meta,
        subscription_data: { metadata: meta },
      });
      return json({ url: session.url });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("[billing] error:", (e as Error).message); // full error server-side only
    return json({ error: "Something went wrong starting checkout — please try again." }, 500);
  }
});
