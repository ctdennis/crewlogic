// crewlogic-link-identity (v1.0) — link an existing profile to the caller's Supabase Auth user.
// SEC-1 (CL-SPEC-004): every Supabase login (Google or magic-link) calls this so the profile's
// auth_user_id is set — which is what the RLS scope helpers (current_franchise_id, etc.) key on.
//
// The current flow leaves some profiles unlinked (Supabase auth.users exist without a linked profile),
// which would make RLS-scoped tables read empty for those users. This closes that gap.
//
// Request (POST):  Authorization: Bearer <supabase access_token>   (no body)
// Response:        { success, linked: bool, email } | { success:false, error }
// Idempotent + safe: only sets auth_user_id when it is currently NULL, so it never steals a profile
// already linked to a different auth user. Matches the profile by email (case-insensitive).
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

  // Verify the caller's Supabase Auth JWT → the authenticated user.
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ success: false, error: "missing_auth" }, 401);
  const { data: { user }, error: uErr } = await sb.auth.getUser(jwt);
  if (uErr || !user || !user.email) return json({ success: false, error: "invalid_auth" }, 401);

  // Link the matching profile only when it has no auth_user_id yet (idempotent; never reassigns).
  const { data, error: linkErr } = await sb
    .from("profiles")
    .update({ auth_user_id: user.id })
    .ilike("email", user.email)
    .is("auth_user_id", null)
    .select("id");
  if (linkErr) return json({ success: false, error: "link_failed", detail: linkErr.message }, 500);

  return json({ success: true, linked: (data?.length || 0) > 0, email: user.email });
});
