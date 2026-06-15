// crewlogic-admin (v1.0) — super-admin-only subscription/trial management.
// Two actions: searchAccounts (find accounts + effective status/trial), setSubscription
// (make_permanent | extend | set_end_date | cancel | reactivate). The franchise-level
// subscription_status is authoritative (can GRANT or REVOKE access). Every mutation writes
// an audit row to subscription_audit. The caller's JWT is verified against SUPER_ADMIN_EMAIL
// BEFORE any action — never trust the client.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

const SUPER_ADMIN = (Deno.env.get("SUPER_ADMIN_EMAIL") || "charles.dennis@junkluggers.com").toLowerCase();
const ACCESS = ["active", "trialing", "tester", "pro", "enterprise"];
const DAY_MS = 86400000;

// PostgREST .or() ilike with a user-supplied term: escape % , and ( ) so the term can't
// break out of the filter grammar. Simplest safe move: strip the few special chars.
function sanitizeTerm(s: string): string {
  return String(s || "").replace(/[%,()\\]/g, " ").trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // --- Caller verification (real auth gate; runs BEFORE any action) ---
    const authHeader = req.headers.get("Authorization") || req.headers.get("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ success: false, error: "forbidden" }, 403);
    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: { user }, error: authErr } = await anon.auth.getUser(token);
    if (authErr || !user || (user.email || "").toLowerCase() !== SUPER_ADMIN) {
      return json({ success: false, error: "forbidden" }, 403);
    }
    const adminEmail = user.email as string;

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const action = String(body.action || "");

    // ===== searchAccounts =====
    if (action === "searchAccounts") {
      // query is OPTIONAL: empty → return ALL accounts (the frontend lists everyone and
      // filters client-side, like the estimate customer lookup). A term still narrows server-side.
      const q = sanitizeTerm(String(body.query || ""));
      let qb = sb
        .from("profiles")
        .select(
          "id,email,name,role,franchise_id,pending_trial_ends_at," +
          "franchises(id,external_id,franchise_name,subscription_status,subscription_tier,trial_ends_at,tenant_id,vonigo_configured," +
          "tenants(id,crm_type,subscription_status,trial_ends_at))"
        );
      if (q) qb = qb.or(`name.ilike.%${q}%,email.ilike.%${q}%`);
      const { data: rows, error } = await qb.order("name", { ascending: true }).limit(200);
      if (error) return json({ success: false, error: error.message }, 500);

      const accounts = (rows || []).map((r: Record<string, unknown>) => {
        const f = (r.franchises || {}) as Record<string, unknown>;
        const t = (f.tenants || {}) as Record<string, unknown>;
        const track = t.crm_type === "vonigo" ? "Vonigo" : "native";
        // franchise.subscription_status is authoritative when set; else franchise tier (only if it
        // is an access value); else tenant status; else 'trialing'.
        let effectiveStatus: string;
        if (f.subscription_status) effectiveStatus = String(f.subscription_status);
        else if (ACCESS.indexOf(String(f.subscription_tier)) !== -1) effectiveStatus = String(f.subscription_tier);
        else if (t.subscription_status) effectiveStatus = String(t.subscription_status);
        else effectiveStatus = "trialing";
        const effectiveTrialEndsAt =
          (f.trial_ends_at as string) || (r.pending_trial_ends_at as string) || (t.trial_ends_at as string) || null;
        return {
          email: r.email,
          name: r.name,
          role: r.role,
          franchiseId: f.id || null,
          franchiseExternalId: f.external_id || null,
          franchiseName: f.franchise_name || null,
          track,
          effectiveStatus,
          effectiveTrialEndsAt,
        };
      });
      return json({ success: true, accounts });
    }

    // ===== setSubscription =====
    if (action === "setSubscription") {
      const franchiseId = String(body.franchiseId || "");
      const op = String(body.op || "");
      const validOps = ["make_permanent", "extend", "set_end_date", "cancel", "reactivate"];
      if (!franchiseId) return json({ success: false, error: "franchiseId required" }, 400);
      if (validOps.indexOf(op) === -1) return json({ success: false, error: "invalid op" }, 400);

      // Load franchise current state.
      const { data: fr, error: frErr } = await sb
        .from("franchises")
        .select("id,subscription_status,trial_ends_at,tenant_id")
        .eq("id", franchiseId)
        .maybeSingle();
      if (frErr) return json({ success: false, error: frErr.message }, 500);
      if (!fr) return json({ success: false, error: "Franchise not found" }, 404);

      // One profile email for audit/target_email.
      const { data: prof } = await sb
        .from("profiles")
        .select("email")
        .eq("franchise_id", franchiseId)
        .limit(1)
        .maybeSingle();
      const targetEmail = (prof && prof.email) || null;

      const oldStatus = fr.subscription_status || null;
      const oldTrial = fr.trial_ends_at || null;
      const days = Number(body.days);
      let newStatus: string;
      let newTrial: string | null;

      if (op === "make_permanent") {
        newStatus = "tester";
        newTrial = null;
      } else if (op === "extend") {
        newStatus = "trialing";
        newTrial = new Date(Date.now() + (days > 0 ? days : 14) * DAY_MS).toISOString();
      } else if (op === "set_end_date") {
        const endDate = String(body.endDate || "");
        // A date-only value (YYYY-MM-DD from the picker) → pin to NOON UTC so it renders as the
        // same calendar day across US/most timezones (avoids the midnight-UTC off-by-one).
        const norm = /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate + "T12:00:00Z" : endDate;
        const parsed = new Date(norm);
        if (!endDate || isNaN(parsed.getTime())) return json({ success: false, error: "invalid endDate" }, 400);
        newStatus = "trialing";
        newTrial = parsed.toISOString();
      } else if (op === "cancel") {
        newStatus = "canceled";
        newTrial = new Date().toISOString();
      } else {
        // reactivate
        newStatus = "trialing";
        newTrial = new Date(Date.now() + (days > 0 ? days : 14) * DAY_MS).toISOString();
      }

      const { error: updErr } = await sb
        .from("franchises")
        .update({ subscription_status: newStatus, trial_ends_at: newTrial })
        .eq("id", franchiseId);
      if (updErr) return json({ success: false, error: updErr.message }, 500);

      // Audit (best-effort log of the full error if it fails, but don't fail the op).
      const { error: auditErr } = await sb.from("subscription_audit").insert({
        admin_email: adminEmail,
        target_email: targetEmail,
        target_franchise_id: franchiseId,
        target_tenant_id: fr.tenant_id || null,
        action: op,
        old_status: oldStatus,
        new_status: newStatus,
        old_trial_ends_at: oldTrial,
        new_trial_ends_at: newTrial,
      });
      if (auditErr) console.error("crewlogic-admin: audit insert failed:", auditErr);

      return json({ success: true, franchiseId, newStatus, newTrialEndsAt: newTrial });
    }

    return json({ success: false, error: "unknown action" }, 400);
  } catch (e) {
    console.error("crewlogic-admin error:", e);
    return json({ success: false, error: (e as Error).message || "Internal error" }, 500);
  }
});
