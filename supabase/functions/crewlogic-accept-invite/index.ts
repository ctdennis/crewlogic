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
    .select("id, franchise_id, role, expires_at, accepted_at")
    .eq("token", inviteToken).maybeSingle();
  if (iErr) return json({ success: false, error: "invite_lookup_failed" }, 500);
  if (!invite) return json({ success: false, error: "invite_invalid" }, 400);
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return json({ success: false, error: "invite_expired" }, 400);
  if (!invite.franchise_id) return json({ success: false, error: "invite_has_no_franchise" }, 400);

  // 3) Idempotent: if this email already has a profile, we're done (covers re-clicks / races).
  const { data: existing } = await sb.from("profiles").select("id, franchise_id").eq("email", email).maybeSingle();
  if (existing) {
    return json({ success: true, email, franchiseId: existing.franchise_id, alreadyProvisioned: true });
  }
  if (invite.accepted_at) return json({ success: false, error: "invite_already_used" }, 400);

  // 4) Create the profile under the invite's (pre-provisioned, native) franchise.
  const { error: pErr } = await sb.from("profiles").insert({
    auth_user_id: user.id,
    email,
    name: (user.user_metadata && (user.user_metadata as Record<string, unknown>).name) || email,
    role: invite.role || "owner",
    franchise_id: invite.franchise_id,
    accepted_invite_id: invite.id,
  });
  if (pErr) return json({ success: false, error: "profile_create_failed", detail: pErr.message }, 500);

  // 5) Mark the invite accepted (best-effort).
  await sb.from("invites").update({ accepted_at: new Date().toISOString() }).eq("id", invite.id);

  return json({ success: true, email, franchiseId: invite.franchise_id });
});
