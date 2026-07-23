// Supabase Edge Function: crewlogic-vonigo-health
//
// Pings Vonigo on a cron (every MINUTE) and EMAILS ALL VONIGO OWNERS when it changes state — down or
// back up. So owners learn Vonigo is out (and that CrewLogic users may hit errors) without waiting
// for a customer to report it.
//
// Alerts fire only on a confirmed TRANSITION, using service_health as the last-known state (migration
// 0065 + fail_streak in 0069). DOWN requires 3 CONSECUTIVE failed checks (debounce vs a transient
// blip); recovery clears on the first success. So a long outage is one "DOWN" email and one
// "recovered" email — never one every cycle, and never on a one-off blip.
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

    // 3-STRIKE DEBOUNCE (owner 2026-07-23): with the 1-minute cron, require 3 consecutive DOWN checks
    // before flipping to DOWN and alerting — a single transient blip never pages. Recovery is asymmetric:
    // any single success clears the streak and flips back to UP immediately (fast to clear, slow to alarm).
    const STRIKES = 3;
    const { data: rows } = await db.from("service_health").select("service,is_up,fail_streak").eq("service", "vonigo").limit(1);
    const prev = rows && rows[0];
    const prevUp = prev ? prev.is_up : true;                 // assume UP if we've never checked
    const prevStreak = prev ? (prev.fail_streak || 0) : 0;

    let newUp = prevUp;
    let newStreak = prevStreak;
    let transitioned = false;
    if (ping.up) {
      newStreak = 0; newUp = true;
      if (!prevUp) transitioned = true;                      // recovery → alert on the first success
    } else {
      newStreak = prevStreak + 1;
      if (prevUp && newStreak >= STRIKES) { newUp = false; transitioned = true; }  // Nth strike confirms the outage
    }
    // Surface the streak in detail while an outage is building but not yet confirmed (e.g. "... [2/3]").
    const detail = ping.up ? ping.detail : ping.detail + " [" + newStreak + "/" + STRIKES + "]";

    if (!prev) {
      await db.from("service_health").insert({ service: "vonigo", is_up: newUp, fail_streak: newStreak, detail, last_checked: now, last_changed: now });
    } else {
      const patch: Record<string, unknown> = { is_up: newUp, fail_streak: newStreak, detail, last_checked: now };
      if (transitioned) patch.last_changed = now;
      await db.from("service_health").update(patch).eq("service", "vonigo");
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
      // Recipients: every owner conducting business in Vonigo (pro/enterprise or a current beta
      // tester) per vonigo_alert_recipients() (migration 0066). ALL go by BCC — including the admin —
      // so everyone is delivered identically and no owner's address is exposed to the others. The
      // visible To falls back to crewlogic-notify's default ops inbox.
      //
      // Why admin-in-BCC: the first live recovery alert (2026-07-23 18:30 UTC) reached all 8 BCC'd
      // owners but NOT the admin, who was the sole visible To — the To slot to that one mailbox dropped
      // the message while every BCC delivered. Moving the admin into BCC delivers them like the 8 that
      // worked.
      let recipients: string[] = [];
      try {
        const { data: recips, error } = await db.rpc("vonigo_alert_recipients");
        if (error) throw error;
        recipients = (recips as { email: string }[] | null || []).map((r) => r.email).filter(Boolean);
      } catch (e) {
        console.error("[vonigo-health] recipient lookup failed:", (e as Error).message);
      }
      if (!recipients.length) recipients = ["charles.dennis@junkluggers.com"];  // never let an alert vanish
      // Best-effort: a notify failure must not break the health check (or it would stop updating state).
      // No `to` → notify uses its default ops inbox; every owner (incl. admin) is a BCC.
      await fetch(SUPABASE_URL + "/functions/v1/crewlogic-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, text, bcc: recipients }),
      }).catch((e) => console.error("[vonigo-health] notify failed:", (e as Error).message));
    }

    return json({ success: true, up: ping.up, detail: ping.detail, transitioned });
  } catch (e) {
    console.error("[vonigo-health] error:", (e as Error).message);
    return json({ success: false, error: "health check failed" }, 500);
  }
});
