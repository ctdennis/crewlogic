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
  // Optional per-call recipient override. Existing callers (signup, feedback) pass no `to` and keep
  // the default inbox; a caller that wants a different owner address (e.g. the Vonigo health alert)
  // passes one. Basic shape check so a bad value can't turn into a Resend error.
  const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
  // `to` may be a single email, a comma/semicolon-separated string, or an array (the DR board's Email
  // modal supports multiple recipients). Validate + de-dup; fall back to the default inbox if none valid.
  const toRaw = Array.isArray(body.to) ? (body.to as unknown[]) : String(body.to || "").split(/[,;]+/);
  const toList = [...new Set(toRaw.map((x) => String(x).trim()).filter(isEmail))];
  const to: string | string[] = toList.length ? toList : TO;
  // Optional BCC fan-out (array of emails). Used by the Vonigo health alert to notify every affected
  // owner in ONE send while keeping each recipient's address private from the others. Filtered to
  // valid, de-duplicated addresses; an empty/absent list just sends to `to`.
  const bccRaw = Array.isArray(body.bcc) ? (body.bcc as unknown[]) : [];
  const bcc = [...new Set(bccRaw.map((x) => String(x).trim()).filter(isEmail))];
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
      body: JSON.stringify({ from: FROM, to, subject, text, ...(bcc.length ? { bcc } : {}) }),
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
