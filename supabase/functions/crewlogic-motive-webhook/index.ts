// Supabase Edge Function: crewlogic-motive-webhook
//
// PHASE 1 — PAYLOAD CAPTURE (temporary). Motive geofence webhooks POST here so we can see the
// EXACT JSON shape (vehicle, geofence, event type, timestamps) before building parsing/storage/display.
// It just logs method + query string + headers + raw body, and returns 200 so Motive marks it delivered.
//
// Read what Motive sent:
//   supabase functions logs crewlogic-motive-webhook --project-ref bagkimfwmpwjfhfhmsrb
//
// Deploy (DEV): supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-motive-webhook --use-api --no-verify-jwt
//
// NEXT PHASES (after we see a real payload): per-franchise token (?f=<token>) for attribution + auth,
// a geofence_alerts table, and the scrolling list in the trucks-map right rail.

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    // convenience: hitting the URL in a browser confirms it's live
    return new Response("crewlogic-motive-webhook is live (POST your Motive webhook here)", { status: 200 });
  }

  let bodyText = "";
  try { bodyText = await req.text(); } catch (_e) { /* ignore */ }

  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) headers[k] = v;

  console.log("[motive-webhook] method=" + req.method + " query=" + (url.search || "(none)"));
  console.log("[motive-webhook] headers=" + JSON.stringify(headers));
  console.log("[motive-webhook] body=" + (bodyText || "(empty)"));

  return new Response(JSON.stringify({ ok: true, received: bodyText.length }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
