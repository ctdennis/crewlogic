// crewlogic-accept-invite (v1.0) — provision a native owner's profile from an accepted invite.
// Part of Phase 2 (native auth, CL-SPEC-003). The caller must be authenticated via Supabase Auth
// (magic-link). We verify their JWT, then use the service role to create their profile under the
// invite's franchise (which the invite-creation step pre-provisions, with native-default tenant).
// Mirrors the Google flow's provisionFromInvite, but for the email/magic-link path.
//
// Request (POST):  Authorization: Bearer <supabase access_token>   body: { inviteToken: string }
// Response:        { success, email, franchiseId } | { success:false, error }
// Idempotent: if a profile already exists for the authed email, returns success without changes.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
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

  // 2) Validate the invite.
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const inviteToken = String(body.inviteToken || "");
  if (!inviteToken) return json({ success: false, error: "invite_token_required" }, 400);

  const { data: invite, error: iErr } = await sb.from("invites")
    .select("id, franchise_id, role, email, expires_at, accepted_at")
    .eq("token", inviteToken).maybeSingle();
  if (iErr) return json({ success: false, error: "invite_lookup_failed" }, 500);
  if (!invite) return json({ success: false, error: "invite_invalid" }, 400);
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return json({ success: false, error: "invite_expired" }, 400);
  // The invite is addressed to a specific email — only that person may accept it (a leaked
  // token can't be redeemed by a different account). Empty invite.email = open invite.
  if (invite.email && String(invite.email).toLowerCase() !== email.toLowerCase()) {
    return json({ success: false, error: "invite_email_mismatch" }, 403);
  }

  // 3) Idempotent: if this email already has a profile, we're done (covers re-clicks / races,
  // and avoids creating a duplicate tenant on a native-onboarding retry).
  const { data: existing } = await sb.from("profiles").select("id, franchise_id").eq("email", email).maybeSingle();
  if (existing) {
    return json({ success: true, email, franchiseId: existing.franchise_id, alreadyProvisioned: true });
  }
  if (invite.accepted_at) return json({ success: false, error: "invite_already_used" }, 400);

  // 4) Resolve the franchise. If the invite already points to one (team member, or a
  // pre-provisioned franchise), use it. Otherwise this is a NEW native franchise — create the
  // tenant (native defaults via migration 0004) + franchise here (provisioning at accept time,
  // same model as the legacy guest flow). The owner supplies the company name on the accept
  // screen. subscription_tier=null so trial access is governed by the tenant's
  // subscription_status='trialing' (default) rather than the paywalling 'free' tier default.
  let franchiseId = invite.franchise_id as string | null;
  if (!franchiseId) {
    const companyName = (String(body.companyName || "").trim()) || ((email.split("@")[1] || "My Company"));
    const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "").slice(0, 40)
      + "-" + crypto.randomUUID().slice(0, 8);
    const { data: tenant, error: tErr } = await sb.from("tenants")
      .insert({ name: companyName, slug, crm_type: "none" }).select("id").single();
    if (tErr || !tenant) return json({ success: false, error: "tenant_create_failed", detail: tErr?.message }, 500);
    const { data: fr, error: fErr } = await sb.from("franchises")
      .insert({ tenant_id: tenant.id, external_id: "native-" + String(tenant.id).slice(0, 8), franchise_name: companyName, subscription_tier: null })
      .select("id").single();
    if (fErr || !fr) return json({ success: false, error: "franchise_create_failed", detail: fErr?.message }, 500);
    franchiseId = fr.id as string;
  }

  // 5) Create the owner profile under the resolved franchise.
  const { error: pErr } = await sb.from("profiles").insert({
    auth_user_id: user.id,
    email,
    name: (user.user_metadata && (user.user_metadata as Record<string, unknown>).name) || email,
    role: invite.role || "owner",
    franchise_id: franchiseId,
    accepted_invite_id: invite.id,
  });
  if (pErr) return json({ success: false, error: "profile_create_failed", detail: pErr.message }, 500);

  // 6) Mark the invite accepted (best-effort).
  await sb.from("invites").update({ accepted_at: new Date().toISOString() }).eq("id", invite.id);

  return json({ success: true, email, franchiseId });
});
