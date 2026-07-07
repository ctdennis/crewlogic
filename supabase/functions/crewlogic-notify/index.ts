// crewlogic-notify (v1.0) — shared owner-notification sender.
// Central place that turns a { subject, text } payload into an email to the CrewLogic owner
// via Resend. Used for best-effort operational alerts (new trial signups, submitted feedback,
// etc.) — callers fire-and-forget and must never let a notify failure break their own flow.
//
// Request (POST):  body { subject: string, text: string }
// Response:        { success: true, id } | { success: false, error } (never leaks Resend internals)
// Config: RESEND_API_KEY secret; From = CrewLogic <notifications@crewlogicai.com>; To = owner inbox.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

const FROM = "CrewLogic <notifications@crewlogicai.com>";
const TO = "bluecollartechai@gmail.com";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const subject = String(body.subject || "").trim();
  const text = String(body.text || "").trim();
  if (!subject || !text) return json({ success: false, error: "subject and text are required" }, 400);

  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.error("[notify] RESEND_API_KEY is not set");
    return json({ success: false, error: "no RESEND_API_KEY" }, 500);
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: TO, subject, text }),
    });
    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    if (!res.ok) {
      // Log full detail server-side; never leak the Resend error to the client (no-internals rule).
      console.error("[notify] Resend send failed (HTTP " + res.status + "):", JSON.stringify(data));
      return json({ success: false, error: "send_failed" }, 502);
    }
    return json({ success: true, id: (data as Record<string, unknown>).id });
  } catch (e) {
    console.error("[notify] Resend request threw:", e);
    return json({ success: false, error: "send_failed" }, 502);
  }
});
