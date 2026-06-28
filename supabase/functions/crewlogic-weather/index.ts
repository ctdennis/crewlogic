// Supabase Edge Function: crewlogic-weather (v1.0)
// Active weather ALERTS for a franchise's area, from the US National Weather Service.
//
// FREE + KEYLESS — api.weather.gov needs no API key, but DOES require a User-Agent header
// (NWS policy), which is why this runs server-side rather than a browser fetch.
//
// POST body: { franchiseID }  (resolves the franchise's officeState from cost_settings)
//        or: { state: "MA" }  (explicit 2-letter state, skips the DB lookup)
//
// Response: { success:true, state, alerts:[ { event, severity, urgency, headline, onset,
//             expires, ends, areaDesc, instruction } ] }   (alerts sorted most-severe first)
//
// Deploy (DEV): supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-weather --use-api --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const TENANT_ID = "946a4535-aa61-45b6-a6fb-9190ff546d41"; // Junkluggers
const UA = "CrewLogicAI/1.0 (dispatch weather alerts; ops@crewlogicai.com)";

// Land-hazard relevance: drop marine/coastal/surf noise that doesn't affect a junk-removal crew.
const SKIP = /\b(marine|coastal|small craft|rip current|beach|surf|ashfall|tsunami|seiche)\b/i;
const SEV_RANK: Record<string, number> = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_e) { /* allow empty */ }

  try {
    let state = String(body.state || "").trim().toUpperCase();
    const franchiseID = String(body.franchiseID || "").trim();

    // Resolve the franchise's state from cost_settings when not passed explicitly.
    if (!state && franchiseID) {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data } = await supabase.from("franchises").select("cost_settings")
        .eq("external_id", franchiseID).eq("tenant_id", TENANT_ID).single();
      const cs = (data?.cost_settings as Record<string, unknown>) || {};
      state = String(cs.officeState || "").trim().toUpperCase();
    }
    if (!/^[A-Z]{2}$/.test(state)) return json({ success: true, state: state || null, alerts: [] }); // no usable state → no alerts

    const res = await fetch(`https://api.weather.gov/alerts/active?area=${state}`, {
      headers: { "User-Agent": UA, "Accept": "application/geo+json" },
    });
    if (!res.ok) {
      console.error("[weather] NWS HTTP", res.status, state);
      return json({ success: false, error: "Weather service unavailable." }, 502);
    }
    const data = await res.json() as { features?: Array<{ properties?: Record<string, unknown> }> };
    const alerts = (data.features || [])
      .map((f) => f.properties || {})
      .filter((p) => p.event && !SKIP.test(String(p.event)))
      .map((p) => ({
        event: p.event, severity: p.severity || "Unknown", urgency: p.urgency || null,
        headline: p.headline || null, onset: p.onset || null, expires: p.expires || null,
        ends: p.ends || null, areaDesc: p.areaDesc || null, instruction: p.instruction || null,
      }))
      .sort((a, b) => (SEV_RANK[String(b.severity)] || 0) - (SEV_RANK[String(a.severity)] || 0));

    return json({ success: true, state, alerts });
  } catch (e) {
    console.error("[weather] error:", (e as Error)?.stack || String(e));
    return json({ success: false, error: "Could not load weather alerts." }, 500);
  }
});
