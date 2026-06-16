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

    // ===== usageSummary =====
    // Per-feature + per-franchise OUR-cost summary from the live `usage_events` metering table.
    // Runs AFTER the super-admin caller verification above (reuses `sb` service-role client).
    if (action === "usageSummary") {
      // OUR cost rates (Anthropic / Google), NOT customer pricing. Safe to hardcode.
      const RATES: Record<string, { in: number; out: number }> = {
        "claude-sonnet-4-6": { in: 3 / 1e6, out: 15 / 1e6 },
        "claude-haiku-4-5-20251001": { in: 1 / 1e6, out: 5 / 1e6 },
      };
      const DEFAULT_AI_RATE = { in: 3 / 1e6, out: 15 / 1e6 }; // unknown model → assume sonnet
      const MAPS_COST: Record<string, number> = {
        "maps.distance_matrix": 0.005,
        "maps.geocode": 0.005,
        "maps.street_view": 0.007,
      };

      const sinceDays = Number(body.sinceDays) > 0 ? Number(body.sinceDays) : 30;
      const franchiseId = body.franchiseId ? String(body.franchiseId) : "";
      const cutoffIso = new Date(Date.now() - sinceDays * DAY_MS).toISOString();

      let uq = sb
        .from("usage_events")
        .select("franchise_id,event_type,model,units,metadata,created_at")
        .gte("created_at", cutoffIso);
      if (franchiseId) uq = uq.eq("franchise_id", franchiseId);
      const { data: events, error: uErr } = await uq
        .order("created_at", { ascending: false })
        .limit(50000);
      if (uErr) return json({ success: false, error: uErr.message }, 500);

      const rows = events || [];
      const capped = rows.length === 50000;

      // Cost-per-row helper.
      function rowCost(r: Record<string, unknown>): { cost: number; tokIn: number; tokOut: number } {
        const et = String(r.event_type || "");
        const md = (r.metadata || {}) as Record<string, unknown>;
        const tokIn = Number(md.tokens_in) || 0;
        const tokOut = Number(md.tokens_out) || 0;
        if (et.indexOf("ai.") === 0) {
          const rate = RATES[String(r.model || "")] || DEFAULT_AI_RATE;
          return { cost: tokIn * rate.in + tokOut * rate.out, tokIn, tokOut };
        }
        if (et.indexOf("maps.") === 0) {
          const per = MAPS_COST[et] != null ? MAPS_COST[et] : 0.005;
          const mult = et === "maps.distance_matrix" ? (Number(md.elements) || 1) : 1;
          return { cost: per * mult, tokIn: 0, tokOut: 0 };
        }
        return { cost: 0, tokIn: 0, tokOut: 0 };
      }

      // Aggregate byType (event_type + model) and byFranchise (franchise_id).
      const typeMap = new Map<string, { eventType: string; model: string; events: number; tokensIn: number; tokensOut: number; costUSD: number }>();
      const franMap = new Map<string, { franchiseId: string | null; events: number; costUSD: number }>();
      let totalEvents = 0;
      let totalCostUSD = 0;

      for (const r of rows) {
        const { cost, tokIn, tokOut } = rowCost(r as Record<string, unknown>);
        const et = String((r as Record<string, unknown>).event_type || "");
        const model = String((r as Record<string, unknown>).model || "");
        const tk = et + "|" + model;
        const tEntry = typeMap.get(tk) || { eventType: et, model, events: 0, tokensIn: 0, tokensOut: 0, costUSD: 0 };
        tEntry.events += 1;
        tEntry.tokensIn += tokIn;
        tEntry.tokensOut += tokOut;
        tEntry.costUSD += cost;
        typeMap.set(tk, tEntry);

        const fidRaw = (r as Record<string, unknown>).franchise_id;
        const fk = fidRaw == null ? "__unattributed__" : String(fidRaw);
        const fEntry = franMap.get(fk) || { franchiseId: fidRaw == null ? null : String(fidRaw), events: 0, costUSD: 0 };
        fEntry.events += 1;
        fEntry.costUSD += cost;
        franMap.set(fk, fEntry);

        totalEvents += 1;
        totalCostUSD += cost;
      }

      // Resolve franchise external_id / name in one query.
      const fids = Array.from(franMap.values())
        .map((f) => f.franchiseId)
        .filter((x): x is string => !!x);
      const fInfo = new Map<string, { externalId: string | null; franchiseName: string | null }>();
      if (fids.length) {
        const { data: frRows } = await sb
          .from("franchises")
          .select("id,external_id,franchise_name")
          .in("id", fids);
        for (const fr of frRows || []) {
          fInfo.set(String(fr.id), { externalId: fr.external_id ?? null, franchiseName: fr.franchise_name ?? null });
        }
      }

      const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

      const byType = Array.from(typeMap.values())
        .map((t) => ({ ...t, costUSD: round4(t.costUSD) }))
        .sort((a, b) => b.costUSD - a.costUSD);

      const byFranchise = Array.from(franMap.values())
        .map((f) => {
          const info = f.franchiseId ? fInfo.get(f.franchiseId) : null;
          return {
            franchiseId: f.franchiseId,
            externalId: info ? info.externalId : null,
            franchiseName: f.franchiseId ? (info ? info.franchiseName : null) : "Unattributed",
            events: f.events,
            costUSD: round4(f.costUSD),
          };
        })
        .sort((a, b) => b.costUSD - a.costUSD);

      return json({
        success: true,
        sinceDays,
        capped,
        totalEvents,
        totalCostUSD: round4(totalCostUSD),
        byType,
        byFranchise,
      });
    }

    return json({ success: false, error: "unknown action" }, 400);
  } catch (e) {
    console.error("crewlogic-admin error:", e);
    return json({ success: false, error: (e as Error).message || "Internal error" }, 500);
  }
});
