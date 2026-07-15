// Supabase Edge Function: crewlogic-linxup-webhook (v1)
//
// Receives Linxup telematics PUSH webhooks (geofence enter/exit, position, stop, trip,
// usage hours, alerts, item-tracking), AUTHENTICATES a Bearer token WE generated,
// ATTRIBUTES to a franchise (?f=<external_id>), and — Phase-1 — stores fence enter/exit
// as a truck alert in `geofence_alerts` (same shape + realtime as the Motive receiver)
// so it shows in the trucks-map Live Alerts rail. All other push types are logged, no-op.
//
// Auth (Linxup contract): Linxup sends the token in an `Authentication: Bearer <token>`
//   header (note: NOT the standard `Authorization`). We also accept `Authorization: Bearer`
//   as a fallback. The token is the one WE generate via crewlogic-settings
//   `saveLinxupWebhookSecret` and the Owner pastes into Linxup; verified against
//   get_linxup_webhook_secret(franchise_id). Success must return HTTP 201 (Linxup requires it).
//
// Payload formats: Linxup documents TWO shapes — FLAT (has `pushType`, e.g. FENCE_EVENT
//   with `fenceEventCd`/`fenceName`) and V3 (has `eventType` + nested `tracker`/`geofence`).
//   We LOG the raw body once per request (so we can confirm which format the account
//   actually sends) and PARSE BOTH.
//
// Deploy (DEV): supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-linxup-webhook --use-api --no-verify-jwt

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, authentication, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

// Constant-time string compare (avoids timing side-channels on the token check).
function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Extract the token from an auth header. Accepts BOTH "Bearer <token>" (strip the scheme) and a
// RAW "<token>" with no scheme — because it's sender-dependent whether Linxup prepends "Bearer "
// or sends the field value verbatim. Either way we compare the bare token to the stored secret.
function bearerOf(headerVal: string | null): string {
  if (!headerVal) return "";
  const m = headerVal.match(/^\s*Bearer\s+(.+)$/i);
  if (m) return m[1].trim();   // "Bearer <token>" → strip the scheme
  return headerVal.trim();     // raw "<token>" with no "Bearer " prefix → accept as-is
}

// Resolve the franchise from ?f=<external_id> (same attribution as the Motive receiver).
async function resolveFranchise(
  sb: SupabaseClient,
  fExternal: string | null,
): Promise<{ uuid: string; tenant_id: string | null; external_id: string | null } | null> {
  if (!fExternal) return null;
  const { data: fr } = await sb
    .from("franchises")
    .select("id, tenant_id, external_id")
    .eq("external_id", fExternal)
    .maybeSingle();
  if (!fr) return null;
  return { uuid: fr.id, tenant_id: fr.tenant_id, external_id: fr.external_id };
}

// Normalize either payload format to a fence event (or a non-fence summary).
interface ParsedLinxup {
  discriminator: string;          // pushType (flat) or eventType (V3) for logging
  isFence: boolean;
  direction: "enter" | "exit" | null;
  eventType: string | null;       // normalized: 'geofence_entry' | 'geofence_exit'
  fenceName: string | null;
  fenceGroup: string | null;      // Linxup's classification label (geofence.fenceGroup) → geofence_alerts.category
  durationSec: number | null;     // on-site seconds (from durationMinutes on exit) → geofence_alerts.duration
  truckName: string | null;
  geofenceId: number | null;      // numeric only (geofence_alerts.geofence_id is bigint)
  eventTimeIso: string | null;
}

function toNumericOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function toIsoOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "number") { const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); }
  const s = String(v); const d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString();
}

function parseLinxup(p: any): ParsedLinxup {
  const flat = p?.pushType != null;
  const v3 = p?.eventType != null;

  // Direction code: FLAT uses fenceEventCd (under pushType FENCE_EVENT); V3 uses eventType.
  const dirCodeRaw = flat ? String(p?.fenceEventCd || "") : (v3 ? String(p?.eventType || "") : "");
  const dirCode = dirCodeRaw.toUpperCase();
  const isFence =
    (flat && String(p?.pushType || "").toUpperCase() === "FENCE_EVENT" && (dirCode === "FENCE_ENTER" || dirCode === "FENCE_EXIT")) ||
    (v3 && (dirCode === "FENCE_ENTER" || dirCode === "FENCE_EXIT"));

  const direction = dirCode === "FENCE_ENTER" ? "enter" : dirCode === "FENCE_EXIT" ? "exit" : null;
  const eventType = direction === "enter" ? "geofence_entry" : direction === "exit" ? "geofence_exit" : null;

  const tracker = p?.tracker || {};
  const geofence = p?.geofence || {};

  const fenceName = (flat ? p?.fenceName : geofence?.name) ?? p?.fenceName ?? geofence?.name ?? null;
  // The classification label. Documented V3 shape nests it as geofence.fenceGroup; FLAT variants call it
  // fenceGroup/groupName. Stamped into geofence_alerts.category so the map treats it like a Motive category.
  const fenceGroup = (flat ? (p?.fenceGroup ?? p?.groupName) : (geofence?.fenceGroup ?? geofence?.groupName)) ?? null;
  const truckName =
    (flat ? (p?.deviceName || p?.trackerName || p?.assetName || p?.driverName || p?.personName)
          : (tracker?.name || tracker?.label || tracker?.deviceName || tracker?.assetName))
    ?? null;
  const geofenceId = toNumericOrNull(flat ? p?.fenceId : (geofence?.geofenceId ?? geofence?.id ?? geofence?.fenceId));
  // V3 carries enterDateTime + (on exit) exitDateTime; FLAT uses eventDate/date/timestamp.
  const eventTimeIso = toIsoOrNull(
    flat
      ? (p?.eventDate ?? p?.date ?? p?.timestamp)
      : ((direction === "exit" ? (p?.exitDateTime ?? p?.enterDateTime) : p?.enterDateTime) ?? p?.eventTime ?? p?.timestamp ?? p?.date),
  );
  // Linxup sends durationMinutes on exit → store as SECONDS (matches Motive's `duration`) in geofence_alerts.duration.
  const durMin = toNumericOrNull(flat ? (p?.durationMinutes ?? p?.duration) : p?.durationMinutes);
  const durationSec = durMin != null ? Math.round(durMin * 60) : null;

  return {
    discriminator: flat ? String(p?.pushType || "") : (v3 ? String(p?.eventType || "") : "unknown"),
    isFence,
    direction,
    eventType,
    fenceName: fenceName != null ? String(fenceName) : null,
    fenceGroup: fenceGroup != null ? String(fenceGroup) : null,
    durationSec,
    truckName: truckName != null ? String(truckName) : null,
    geofenceId,
    eventTimeIso,
  };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return new Response("crewlogic-linxup-webhook v1 is live", { status: 200, headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  const rawBody = await req.text().catch(() => "");
  // log-then-parse: always capture the raw body once so we can confirm the real format.
  console.log("[linxup-webhook] raw body:", rawBody.slice(0, 2000));

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const fExternal = url.searchParams.get("f");


  // Attribution first — no franchise, no auth possible.
  const franchise = await resolveFranchise(sb, fExternal);
  if (!franchise) {
    console.error("[linxup-webhook] unknown/missing franchise (f=" + (fExternal || "none") + ")");
    return new Response(JSON.stringify({ success: false, error: "unknown franchise" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Auth: prefer the `Authentication` header (Linxup's convention); fall back to `Authorization`.
  const presented = bearerOf(req.headers.get("Authentication")) || bearerOf(req.headers.get("Authorization"));
  const { data: secret } = await sb.rpc("get_linxup_webhook_secret", { p_franchise_id: franchise.uuid });
  const expected = secret ? String(secret) : "";
  if (!expected || !presented || !timingSafeEqualStr(presented, expected)) {
    console.error("[linxup-webhook] auth failed (f=" + franchise.external_id + ")");
    return new Response(JSON.stringify({ success: false, error: "unauthorized" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Parse defensively.
  let parsed: any = null;
  try { parsed = JSON.parse(rawBody); } catch (_e) { parsed = null; }
  if (parsed == null || typeof parsed !== "object") {
    console.log("[linxup-webhook] non-JSON / empty body — ack, no action (f=" + franchise.external_id + ")");
    return new Response(JSON.stringify({ success: true }), { status: 201, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const ev = parseLinxup(parsed);

  // Phase-1: only fence enter/exit becomes a truck alert. Everything else = log + no-op.
  if (!ev.isFence) {
    console.log(`[linxup-webhook] non-fence push type=${ev.discriminator} — no action (f=${franchise.external_id})`);
    return new Response(JSON.stringify({ success: true }), { status: 201, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Reuse the Motive receiver's geofence_alerts insert shape exactly.
  const { error } = await sb.from("geofence_alerts").insert({
    franchise_id: franchise.uuid,
    tenant_id: franchise.tenant_id,
    action: "linxup_fence_event",
    event_type: ev.eventType,               // geofence_entry | geofence_exit (matches Motive)
    vehicle_id: null,                         // Linxup identifies by tracker name, not a numeric id
    vehicle_number: ev.truckName,
    geofence_id: ev.geofenceId,               // numeric fence id when present, else null
    geofence_name: ev.fenceName,
    category: ev.fenceGroup,                  // Linxup Group → same column Motive stamps its Category into (drives the badge)
    event_id: null,
    start_time: ev.eventTimeIso,
    end_time: null,
    duration: ev.durationSec,                 // on-site seconds (exit events) — powers the alerts report
    raw: parsed,
  });
  if (error) {
    console.error("[linxup-webhook] insert failed:", error.message);
    return new Response(JSON.stringify({ success: false, error: "store failed" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  console.log(`[linxup-webhook] stored ${ev.eventType} fence="${ev.fenceName ?? ""}" truck="${ev.truckName ?? ""}" f=${franchise.external_id}`);
  return new Response(JSON.stringify({ success: true }), { status: 201, headers: { ...CORS, "Content-Type": "application/json" } });
});
