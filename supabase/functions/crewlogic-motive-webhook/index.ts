// Supabase Edge Function: crewlogic-motive-webhook
//
// PHASE 1 — PAYLOAD CAPTURE (temporary). Motive geofence webhooks POST here so we can see the
// EXACT JSON shape (vehicle, geofence, event type, timestamps) before building parsing/storage/display.
// It logs + STORES each request (method, query, headers, raw body) into `motive_webhook_capture`
// so we can read it via SQL (this CLI can't pull function logs), then returns 200.
//
// Read what Motive sent:
//   bash supabase/dev-setup/dev-sql.sh "select id, query, body, created_at from motive_webhook_capture order by id desc limit 10"
//
// Deploy (DEV): supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-motive-webhook --use-api --no-verify-jwt
//
// NEXT PHASES (after we see a real payload): per-franchise token (?f=<token>) for attribution + auth,
// a geofence_alerts table, and the scrolling list in the trucks-map right rail.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    return new Response("crewlogic-motive-webhook is live (POST your Motive webhook here)", { status: 200 });
  }

  let bodyText = "";
  try { bodyText = await req.text(); } catch (_e) { /* ignore */ }

  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) headers[k] = v;

  console.log("[motive-webhook] method=" + req.method + " query=" + (url.search || "(none)"));
  console.log("[motive-webhook] body=" + (bodyText || "(empty)"));

  // Store it so we can read the exact shape via SQL (CLI can't fetch function logs).
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await supabase.from("motive_webhook_capture").insert({
      method: req.method,
      query: url.search || null,
      headers,
      body: bodyText || null,
    });
  } catch (e) {
    console.error("[motive-webhook] capture insert failed:", (e as Error)?.message);
  }

  return new Response(JSON.stringify({ ok: true, received: bodyText.length }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
