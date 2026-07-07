// crewlogic-signup (v1.0) — provision a brand-new NATIVE owner's workspace with NO invite
// (self-serve signup, email/magic-link path). Part of Phase 2 (native auth, CL-SPEC-003).
//
// The caller must be authenticated via Supabase Auth (magic-link). We verify their JWT, then use
// the service role to create a native tenant+franchise (native defaults, migration 0004) and the
// owner's profile under it. This is the email-path twin of the Google flow's provisionFromSignup
// in crewlogic-oauth-callback — both reuse _shared/provisionNative.ts so they stay in lockstep.
//
// Request (POST):  Authorization: Bearer <supabase access_token>   body: { companyName?: string }
// Response:        { success, email, franchiseId } | { success:false, error }
// Idempotent: if a profile already exists for the authed email, returns success without changes
// (and without creating a second tenant).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createNativeTenantAndFranchise } from "../_shared/provisionNative.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Best-effort owner notification. Fires the shared crewlogic-notify sender; a failure here must
// NEVER break provisioning, so everything is wrapped and only logged.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
async function notifyOwner(subject: string, text: string): Promise<void> {
  try {
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(SUPABASE_URL + "/functions/v1/crewlogic-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": key, "Authorization": "Bearer " + key },
      body: JSON.stringify({ subject, text }),
    });
  } catch (e) {
    console.error("[signup] notify failed:", e);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 1) Verify the caller's Supabase Auth JWT → get the authenticated user.
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ success: false, error: "missing_auth" }, 401);
  const { data: { user }, error: uErr } = await sb.auth.getUser(jwt);
  if (uErr || !user || !user.email) return json({ success: false, error: "invalid_auth" }, 401);
  const email = user.email;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const companyName = (String(body.companyName || "").trim()) || ((email.split("@")[1] || "My Company"));
  // Owner's display name, collected on the post-verify "Name your workspace" step (optional).
  const ownerName = String(body.ownerName || "").trim();

  // 2) Idempotent: if this email already has a profile, we're done (covers re-clicks / races and
  // avoids creating a duplicate tenant on a signup retry).
  const { data: existing } = await sb.from("profiles").select("id, franchise_id").eq("email", email).maybeSingle();
  if (existing) {
    return json({ success: true, email, franchiseId: existing.franchise_id, alreadyProvisioned: true });
  }

  // 2b) Junkluggers prospect (access matrix cell #4). A @junkluggers.com email NEVER gets a native
  // tenant — they belong on the Vonigo track. Provision a Vonigo-PENDING profile (franchise_id NULL,
  // no tenant); they connect their Vonigo credentials in Settings, which attaches their real franchise
  // under the shared Junkluggers tenant. Marketing-funnel prospects (marketingTrial) carry a 14-day
  // trial whose clock starts NOW (at signup); pending_trial_ends_at is copied onto their franchise at
  // connect (so it survives even though the shared Junkluggers tenant is 'tester').
  const isJunkluggers = /@junkluggers\.com$/i.test(email);
  if (isJunkluggers) {
    const marketingTrial = body.marketingTrial === true;
    const trialEndsAt = marketingTrial
      ? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
      : null;
    const { error: jErr } = await sb.from("profiles").insert({
      auth_user_id: user.id,
      email,
      name: ownerName || (user.user_metadata && (user.user_metadata as Record<string, unknown>).name as string) || email,
      role: "owner",
      franchise_id: null,
      pending_trial_ends_at: trialEndsAt,
    });
    if (jErr) return json({ success: false, error: "profile_create_failed", detail: jErr.message }, 500);
    await notifyOwner("🎉 New CrewLogic trial signup",
      `Email: ${email}\nCompany: ${companyName}\nType: Junkluggers prospect\nTrial ends: ${trialEndsAt || "n/a"}\nFranchise: (pending)`);
    return json({ success: true, email, franchiseId: null, vonigoPending: true, trialEndsAt });
  }

  // 3) Provision the native tenant+franchise (native defaults; subscription_tier=null so trial
  // access is governed by the tenant's subscription_status='trialing' default).
  let franchiseId: string;
  try {
    const r = await createNativeTenantAndFranchise(sb, companyName);
    franchiseId = r.franchiseId;
  } catch (e) {
    return json({ success: false, error: "native_provision_failed", detail: String((e as Error).message) }, 500);
  }

  // 4) Create the owner profile under the new franchise.
  const { error: pErr } = await sb.from("profiles").insert({
    auth_user_id: user.id,
    email,
    name: ownerName || (user.user_metadata && (user.user_metadata as Record<string, unknown>).name as string) || email,
    role: "owner",
    franchise_id: franchiseId,
  });
  if (pErr) return json({ success: false, error: "profile_create_failed", detail: pErr.message }, 500);

  await notifyOwner("🎉 New CrewLogic trial signup",
    `Email: ${email}\nCompany: ${companyName}\nType: native\nTrial ends: n/a\nFranchise: ${franchiseId}`);
  return json({ success: true, email, franchiseId });
});
