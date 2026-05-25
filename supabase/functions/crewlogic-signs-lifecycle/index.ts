// Supabase Edge Function: crewlogic-signs-lifecycle (v1.0)
// Daily yard-sign aging: active -> gray (after graySignDays, default 15) and
// gray -> hidden (after hiddenSignDays, default 60), per-franchise thresholds from
// cost_settings->signs. Logs each transition to sign_status_events.
// Migrated from the n8n "CrewLogic Signs - Daily Lifecycle" cron.
//
// The transition logic lives in the SQL function signs_daily_lifecycle() (set-based
// across all franchises). This function runs it, then posts a Slack summary IF a
// SLACK_SIGNS_WEBHOOK is configured and any signs transitioned.
//
// SECRETS:
//   SLACK_SIGNS_WEBHOOK  — (optional) Slack Incoming Webhook URL for #crewlogic-signs.
//                          If unset, transitions still run; the summary is just skipped.
//
// Invoked daily by pg_cron via pg_net. Idempotent (a sign transitions at most once).
// Deploy: supabase functions deploy crewlogic-signs-lifecycle

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const { data, error } = await supabase.rpc("signs_daily_lifecycle");
    if (error) {
      console.error("[signs-lifecycle] rpc failed:", error.message);
      return jsonResponse({ success: false, error: error.message }, 500);
    }
    const row = (Array.isArray(data) ? data[0] : data) || {};
    const grayed = Number(row.grayed_count) || 0;
    const hidden = Number(row.hidden_count) || 0;

    // Optional Slack summary (only when configured AND something changed).
    let slackPosted = false;
    const webhook = Deno.env.get("SLACK_SIGNS_WEBHOOK");
    if (webhook && (grayed > 0 || hidden > 0)) {
      try {
        const text = `🪧 *CrewLogic Signs — daily lifecycle*\n• ${grayed} sign(s) aged active → gray\n• ${hidden} sign(s) moved gray → hidden`;
        const r = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        slackPosted = r.ok;
        if (!r.ok) console.warn(`[signs-lifecycle] Slack post ${r.status}`);
      } catch (e) {
        console.warn(`[signs-lifecycle] Slack error: ${(e as Error).message}`);
      }
    }

    return jsonResponse({ success: true, grayed, hidden, slackPosted });
  } catch (e) {
    const err = e as Error;
    console.error("[signs-lifecycle] error:", err?.message || err);
    return jsonResponse({ success: false, error: err.message || "Internal error" }, 500);
  }
});
