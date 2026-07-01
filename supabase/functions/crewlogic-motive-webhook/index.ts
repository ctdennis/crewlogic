// Supabase Edge Function: crewlogic-motive-webhook (v2)
//
// Receives Motive telematics webhooks (geofence entry/exit, ignition on/off, speed, faults),
// VERIFIES the signature, ATTRIBUTES to a franchise, resolves geofence names, and stores each
// event in `geofence_alerts` for the trucks-map right-rail list (display = next phase).
//
// Signature: Motive sends `x-kt-webhook-signature` = HMAC-SHA1(rawBody, secret) hex. We verify
//   against the franchise's secret (Vault, via get_motive_webhook_secret). Attribution:
//     ?f=<franchise externalID>  -> verify against that franchise's secret, else 401.
//     no ?f=                     -> try each configured franchise's secret; first match wins, else 401.
//   Webhook activation posts a JSON ARRAY of event-type strings (handshake) -> just 200.
//
// Geofence payloads carry only geofence_id; the name is resolved from Motive's API
//   (GET /v1/geofences, per-franchise token via get_telematics_credential) and cached in motive_geofences.
//
// Deploy (DEV): supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-motive-webhook --use-api --no-verify-jwt

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SIG_HEADER = "x-kt-webhook-signature";

const enc = new TextEncoder();

async function hmacSha1Hex(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Call a sibling edge function with the service key (internal service-to-service).
async function callFn(name: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(SUPABASE_URL + "/functions/v1/" + name, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

type Cand = { uuid: string; tenant_id: string | null; external_id: string | null; secret: string };

// Candidate franchise(s) + their secrets: exact when ?f= given, else every configured franchise.
async function candidates(sb: SupabaseClient, fExternal: string | null): Promise<Cand[]> {
  const load = async (fr: { id: string; tenant_id: string | null; external_id: string | null }): Promise<Cand | null> => {
    const { data: secret } = await sb.rpc("get_motive_webhook_secret", { p_franchise_id: fr.id });
    if (!secret) return null;
    return { uuid: fr.id, tenant_id: fr.tenant_id, external_id: fr.external_id, secret: String(secret) };
  };
  if (fExternal) {
    const { data: fr } = await sb.from("franchises").select("id, tenant_id, external_id").eq("external_id", fExternal).maybeSingle();
    if (!fr) return [];
    const c = await load(fr);
    return c ? [c] : [];
  }
  const { data: cfgs } = await sb.from("motive_webhook_config").select("franchise_id");
  const out: Cand[] = [];
  for (const cfg of cfgs || []) {
    const { data: fr } = await sb.from("franchises").select("id, tenant_id, external_id").eq("id", cfg.franchise_id).maybeSingle();
    if (!fr) continue;
    const c = await load(fr);
    if (c) out.push(c);
  }
  return out;
}

// geofence_id -> name (cache first, else fetch the franchise's Motive geofences and cache all).
async function resolveGeofenceName(sb: SupabaseClient, franchiseUuid: string, geofenceId: number): Promise<string | null> {
  const { data: cached } = await sb.from("motive_geofences").select("name").eq("franchise_id", franchiseUuid).eq("geofence_id", geofenceId).maybeSingle();
  if (cached && cached.name != null) return cached.name;
  try {
    const { data: cred } = await sb.rpc("get_telematics_credential", { p_franchise_id: franchiseUuid });
    const row = Array.isArray(cred) ? cred[0] : cred;
    const provider = String(row?.provider || "").toLowerCase();
    const token = String(row?.token || "");
    if (provider !== "motive" || !token) return null;
    const res = await fetch("https://api.gomotive.com/v1/geofences?per_page=100", { headers: { accept: "application/json", "x-api-key": token } });
    if (!res.ok) { console.error("[motive-webhook] geofences GET", res.status); return null; }
    const data = await res.json().catch(() => ({}));
    const list: any[] = Array.isArray(data) ? data : (data.geofences || []);
    const rows: any[] = [];
    let found: string | null = null;
    for (const item of list) {
      const g = item?.geofence || item;
      if (g && g.id != null) {
        rows.push({ franchise_id: franchiseUuid, geofence_id: Number(g.id), name: g.name ?? null });
        if (Number(g.id) === Number(geofenceId)) found = g.name ?? null;
      }
    }
    if (rows.length) await sb.from("motive_geofences").upsert(rows, { onConflict: "franchise_id,geofence_id" });
    return found;
  } catch (e) {
    console.error("[motive-webhook] geofence name resolve failed:", (e as Error).message);
    return null;
  }
}

function parseEvent(p: any): {
  action: string; event_type: string; vehicle_id: number | null; vehicle_number: string | null;
  geofence_id: number | null; event_id: number | null; start_time: string | null; end_time: string | null; duration: number | null;
} {
  const action = String(p.action || "");
  if (action === "vehicle_geofence_event") {
    return {
      action, event_type: String(p.event_type || "geofence"),
      vehicle_id: p.vehicle?.id ?? null, vehicle_number: p.vehicle?.number ?? null,
      geofence_id: p.geofence_id ?? null, event_id: p.id ?? null,
      start_time: p.start_time ?? null, end_time: p.end_time ?? null, duration: p.duration ?? null,
    };
  }
  if (action === "engine_toggle_event") {
    return {
      action, event_type: "engine_" + String(p.trigger || "toggle"),
      vehicle_id: p.vehicle_id ?? null, vehicle_number: p.vehicle_number ?? null,
      geofence_id: null, event_id: null, start_time: p.updated_at ?? null, end_time: null, duration: null,
    };
  }
  // any other action (speed, fault, etc.) — store generically
  return {
    action: action || "unknown", event_type: String(p.event_type || p.trigger || action || "unknown"),
    vehicle_id: p.vehicle?.id ?? p.vehicle_id ?? null, vehicle_number: p.vehicle?.number ?? p.vehicle_number ?? null,
    geofence_id: p.geofence_id ?? null, event_id: p.id ?? null,
    start_time: p.start_time ?? p.updated_at ?? null, end_time: p.end_time ?? null, duration: p.duration ?? null,
  };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "GET") return new Response("crewlogic-motive-webhook v2 is live", { status: 200 });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const rawBody = await req.text().catch(() => "");

  // Activation handshake: Motive posts a JSON array of event-type strings — ack without a signature.
  let parsed: any = null;
  try { parsed = JSON.parse(rawBody); } catch (_e) { /* not JSON */ }
  if (Array.isArray(parsed)) {
    console.log("[motive-webhook] activation handshake:", rawBody.slice(0, 200));
    return new Response(JSON.stringify({ ok: true, handshake: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const sig = req.headers.get(SIG_HEADER) || "";
  if (!sig) return new Response(JSON.stringify({ ok: false, error: "missing signature" }), { status: 401 });

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const fExternal = url.searchParams.get("f");

  // Verify + attribute: find the franchise whose secret reproduces the signature over the RAW body.
  let matched: Cand | null = null;
  for (const c of await candidates(sb, fExternal)) {
    if (timingSafeEqualHex(await hmacSha1Hex(rawBody, c.secret), sig)) { matched = c; break; }
  }
  if (!matched) {
    console.error("[motive-webhook] signature verification failed (f=" + (fExternal || "none") + ")");
    return new Response(JSON.stringify({ ok: false, error: "invalid signature" }), { status: 401 });
  }

  const ev = parseEvent(parsed || {});

  // Is this a JOB geofence (auto-created by crewlogic-job-geofence-sync for today's jobs)?
  // If so we already know the name; relabel as job_arrive / job_leave, and on EXIT delete the
  // Motive geofence + mark the mapping row done (delete-on-exit). EOD sweep is the backstop.
  let jobGeo: { id: any; name: string | null } | null = null;
  if (ev.action === "vehicle_geofence_event" && ev.geofence_id != null) {
    const { data: jg } = await sb.from("job_geofences")
      .select("id, name")
      .eq("franchise_id", matched.uuid).eq("geofence_id", ev.geofence_id).eq("status", "active")
      .maybeSingle();
    if (jg) jobGeo = { id: jg.id, name: jg.name ?? null };
  }

  let eventType = ev.event_type;
  let geofenceName: string | null = null;
  if (jobGeo) {
    const isExit = ev.event_type === "geofence_exit";
    eventType = isExit ? "job_leave" : "job_arrive";
    geofenceName = jobGeo.name; // no Motive name lookup needed — we created it
    if (isExit) {
      try {
        const del = await callFn("crewlogic-geofence-create", { action: "delete", franchiseID: matched.external_id, geofence_id: ev.geofence_id });
        if (!del.ok || !del.data?.success) console.error("[motive-webhook] job geofence delete failed:", JSON.stringify(del.data).slice(0, 200));
      } catch (e) {
        console.error("[motive-webhook] job geofence delete error:", (e as Error).message);
      }
      await sb.from("job_geofences").update({ status: "deleted", deleted_at: new Date().toISOString() }).eq("id", jobGeo.id);
    }
  } else if (ev.geofence_id != null) {
    geofenceName = await resolveGeofenceName(sb, matched.uuid, ev.geofence_id);
  }

  const { error } = await sb.from("geofence_alerts").insert({
    franchise_id: matched.uuid, tenant_id: matched.tenant_id,
    action: ev.action, event_type: eventType,
    vehicle_id: ev.vehicle_id, vehicle_number: ev.vehicle_number,
    geofence_id: ev.geofence_id, geofence_name: geofenceName, event_id: ev.event_id,
    start_time: ev.start_time, end_time: ev.end_time, duration: ev.duration,
    raw: parsed,
  });
  if (error) {
    console.error("[motive-webhook] insert failed:", error.message);
    return new Response(JSON.stringify({ ok: false, error: "store failed" }), { status: 500 });
  }

  console.log(`[motive-webhook] stored ${ev.action}/${eventType} veh=${ev.vehicle_number} f=${matched.external_id}${jobGeo ? " (job)" : ""}`);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
});
