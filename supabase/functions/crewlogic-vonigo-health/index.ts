// Supabase Edge Function: crewlogic-vonigo-health
//
// Pings Vonigo on a cron (every 5 min) and EMAILS THE OWNER when it changes state — down or back
// up. So the owner learns Vonigo is out (and that CrewLogic users may hit errors) without waiting
// for a customer to report it.
//
// Alerts fire only on a TRANSITION, using service_health as the last-known state (migration 0065),
// so a long outage is one "DOWN" email and one "recovered" email — not one every cycle.
//
// UP vs DOWN: Vonigo's /security/login/ returns JSON with an errNo field even for bad credentials
// (which is what we send — a dummy health-check login). So a PARSEABLE JSON body = Vonigo is up.
// A 522/timeout/HTML error page (Cloudflare "origin unreachable") = down. That HTML is exactly
// what breaks the estimate screen's job lookup with "Unexpected token '<'".
//
// Config: RESEND_API_KEY (via crewlogic-notify). No Vonigo credentials needed — a bad-cred login
// still proves the endpoint is alive.
//
// Deploy (DEV):
//   supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-vonigo-health --use-api --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
// Dummy creds on purpose: we are testing whether the endpoint ANSWERS, not logging in. Vonigo
// returns a JSON errNo for bad creds when it is up.
const VONIGO_PING = "https://junkluggers.vonigo.com/api/v1/security/login/?company=Vonigo&userName=healthcheck&password=healthcheck";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function pingVonigo(): Promise<{ up: boolean; detail: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(VONIGO_PING, { signal: ctrl.signal });
    clearTimeout(t);
    const body = (await r.text()).trim();
    try {
      JSON.parse(body);                       // parseable JSON → Vonigo answered → UP
      return { up: true, detail: "HTTP " + r.status };
    } catch {
      return { up: false, detail: "HTTP " + r.status + (body.startsWith("<") ? " (HTML error page)" : " (non-JSON)") };
    }
  } catch (e) {
    // timeout / connection refused / DNS — Cloudflare 522 often surfaces here on abort
    return { up: false, detail: "unreachable: " + String((e as Error).message).slice(0, 60) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const db = createClient(SUPABASE_URL, SERVICE_KEY);
    const ping = await pingVonigo();
    const now = new Date().toISOString();

    const { data: rows } = await db.from("service_health").select("service,is_up").eq("service", "vonigo").limit(1);
    const prev = rows && rows[0];

    let transitioned = false;
    if (!prev) {
      await db.from("service_health").insert({ service: "vonigo", is_up: ping.up, detail: ping.detail, last_checked: now, last_changed: now });
      transitioned = !ping.up;                // first sighting: only alert if it is already DOWN
    } else if (prev.is_up !== ping.up) {
      await db.from("service_health").update({ is_up: ping.up, detail: ping.detail, last_checked: now, last_changed: now }).eq("service", "vonigo");
      transitioned = true;
    } else {
      await db.from("service_health").update({ detail: ping.detail, last_checked: now }).eq("service", "vonigo");
    }

    if (transitioned) {
      const subject = ping.up
        ? "Vonigo is back UP"
        : "Vonigo is DOWN - CrewLogic Vonigo features affected";
      const text = ping.up
        ? "Vonigo is responding again (" + ping.detail + "). Job lookup, estimate submission, today's jobs and the dispatch board should work now."
        : "Vonigo is not responding (" + ping.detail + ").\n\n" +
          "CrewLogic features that depend on Vonigo will fail until it recovers:\n" +
          "  - Vonigo job lookup (estimate screen)\n" +
          "  - Estimate submission to Vonigo\n" +
          "  - Today's jobs / the dispatch board\n\n" +
          "Native features are UNAFFECTED: pricing, recycling revenue, coupon lookup.\n\n" +
          "Users may see errors on the Vonigo-dependent screens. Nothing to fix on CrewLogic's side - " +
          "it recovers when Vonigo's servers come back. You'll get a follow-up email when it does.";
      // Best-effort: a notify failure must not break the health check (or it would stop updating state).
      await fetch(SUPABASE_URL + "/functions/v1/crewlogic-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Owner's real inbox — the shared notify default (bluecollartechai@gmail.com) is where
        // signup/feedback go, but the owner wants operational Vonigo alerts here.
        body: JSON.stringify({ subject, text, to: "charles.dennis@junkluggers.com" }),
      }).catch((e) => console.error("[vonigo-health] notify failed:", (e as Error).message));
    }

    return json({ success: true, up: ping.up, detail: ping.detail, transitioned });
  } catch (e) {
    console.error("[vonigo-health] error:", (e as Error).message);
    return json({ success: false, error: "health check failed" }, 500);
  }
});
