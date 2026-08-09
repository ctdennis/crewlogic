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
import { resolveTimezone, todayPartsInTz } from "../_shared/tz.ts";

// Franchise-local "today" (YYYY-MM-DD) for the geofence auto-assign — service_date/scheduled_date are
// franchise-local (multi-tenant TZ rule: never assume the server/UTC zone).
async function franchiseToday(sb: SupabaseClient, franchiseId: string): Promise<string> {
  const { data } = await sb.from("franchises").select("cost_settings").eq("id", franchiseId).maybeSingle();
  const tz = resolveTimezone((data?.cost_settings as Record<string, unknown>) || {});
  const { year, month, day } = todayPartsInTz(tz);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Server-side geofence AUTO-ASSIGN (FW-16): EVERY truck that ARRIVES on a route gets assigned to it —
// appended, not capped at one — so a genuine two-truck (double-team) job shows both crews. Done HERE
// (not just in the open dispatch board) so it happens even with no browser watching. The ops manager can
// unassign a truck; a manual replace-set ('set') is the override. The route id is the NUMERIC Vonigo route objectID carried on the arrival's
// job_geofences row (job_geofences.route_id, populated by crewlogic-job-geofence-sync and refreshed on
// route change), so it maps straight onto route_truck_assignments.vonigo_route_id. Robust to:
//   • cancel     — a cancelled job's fence is deleted by the sync, so jobGeo won't resolve → no assign.
//   • reschedule — the assignment is scoped to franchise-local TODAY; a moved job auto-assigns on its day.
//   • route move — the sync keeps the active fence's route_id current, so a later arrival assigns the NEW route.
// Best-effort: any failure is logged and swallowed, never blocking the alert.
async function autoAssignOnArrival(sb: SupabaseClient, franchiseId: string, routeId: string | null, routeName: string | null, vehicleNumber: string | null): Promise<void> {
  if (!routeId || !vehicleNumber) return;
  try {
    const day = await franchiseToday(sb, franchiseId);
    // truck_key for the arrived vehicle (franchise_trucks.name === Motive vehicle number).
    const { data: truck } = await sb.from("franchise_trucks")
      .select("truck_key").eq("franchise_id", franchiseId).eq("name", vehicleNumber).eq("active", true).eq("out_of_service", false).maybeSingle();  // disabled trucks don't geofence-auto-assign
    const truckKey = truck?.truck_key;
    if (!truckKey) return;
    // EVERY truck that ARRIVES on a route's job gets assigned — APPEND, don't cap at one. If a crew was on
    // site we want the board to show them; the ops manager can unassign. Idempotent on the
    // (franchise, day, route, truck) unique key: a re-arrival of the same truck is a no-op, and any truck
    // already on the route (including a manual hard-set) is left untouched — we never overwrite or delete
    // another truck's row. A manual replace-set (action 'set') is still the ops override.
    const { error } = await sb.from("route_truck_assignments")
      .upsert({
        franchise_id: franchiseId, service_date: day, vonigo_route_id: String(routeId), route_name: routeName,
        truck_key: truckKey, source: "inferred", confidence: "geofence-arrival", assigned_by: "geofence-auto",
      }, { onConflict: "franchise_id,service_date,vonigo_route_id,truck_key", ignoreDuplicates: true });
    if (error) { console.error("[motive-webhook] auto-assign upsert failed:", error.message); return; }
    console.log(`[motive-webhook] AUTO-ASSIGNED ${vehicleNumber} -> route ${routeId} (${day})`);
  } catch (e) {
    console.error("[motive-webhook] auto-assign failed (non-fatal):", (e as Error).message);
  }
}

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

// geofence_id -> { name, category } (cache first, else fetch the franchise's Motive geofences and cache all).
// The telematics `category` (e.g. "Recycling", "Transfer Station", "Donation") is the reliable facility
// signal; the frontend classifies on it, falling back to name-match for pre-category rows / other providers.
async function resolveGeofenceName(sb: SupabaseClient, franchiseUuid: string, geofenceId: number): Promise<{ name: string | null; category: string | null }> {
  const { data: cached } = await sb.from("motive_geofences").select("name, category").eq("franchise_id", franchiseUuid).eq("geofence_id", geofenceId).maybeSingle();
  if (cached && cached.name != null) return { name: cached.name, category: cached.category ?? null };
  try {
    const { data: cred } = await sb.rpc("get_telematics_credential", { p_franchise_id: franchiseUuid });
    const row = Array.isArray(cred) ? cred[0] : cred;
    const provider = String(row?.provider || "").toLowerCase();
    const token = String(row?.token || "");
    if (provider !== "motive" || !token) return { name: null, category: null };
    const res = await fetch("https://api.gomotive.com/v1/geofences?per_page=100", { headers: { accept: "application/json", "x-api-key": token } });
    if (!res.ok) { console.error("[motive-webhook] geofences GET", res.status); return { name: null, category: null }; }
    const data = await res.json().catch(() => ({}));
    const list: any[] = Array.isArray(data) ? data : (data.geofences || []);
    const rows: any[] = [];
    let found: { name: string | null; category: string | null } = { name: null, category: null };
    for (const item of list) {
      const g = item?.geofence || item;
      if (g && g.id != null) {
        rows.push({ franchise_id: franchiseUuid, geofence_id: Number(g.id), name: g.name ?? null, category: g.category ?? null });
        if (Number(g.id) === Number(geofenceId)) found = { name: g.name ?? null, category: g.category ?? null };
      }
    }
    if (rows.length) await sb.from("motive_geofences").upsert(rows, { onConflict: "franchise_id,geofence_id" });
    return found;
  } catch (e) {
    console.error("[motive-webhook] geofence name resolve failed:", (e as Error).message);
    return { name: null, category: null };
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
  // If so we already know the name; relabel as job_arrive / job_leave. We do NOT delete on exit —
  // the geofence persists for the whole job (multi-truck arrive/leave/return). Deletion is handled
  // by the sync (Vonigo WO done/cancelled) and the EOD sweep.
  let jobGeo: { id: any; name: string | null; wo_id: string | null; job_id: string | null; route: string | null; route_id: string | null } | null = null;
  if (ev.action === "vehicle_geofence_event" && ev.geofence_id != null) {
    const { data: jg } = await sb.from("job_geofences")
      .select("id, name, wo_id, job_id, route, route_id")
      .eq("franchise_id", matched.uuid).eq("geofence_id", ev.geofence_id).eq("status", "active")
      .maybeSingle();
    if (jg) jobGeo = { id: jg.id, name: jg.name ?? null, wo_id: jg.wo_id ?? null, job_id: jg.job_id ?? null, route: jg.route ?? null, route_id: jg.route_id ?? null };
  }

  let eventType = ev.event_type;
  let geofenceName: string | null = null;
  let geofenceCategory: string | null = null;
  if (jobGeo) {
    // A truck LEAVING is never a delete signal: multi-truck jobs have trucks arrive/leave/return
    // (dump-and-come-back) in any order, so the geofence must persist through the whole job.
    // Deletion happens only when the Vonigo WO is marked done/cancelled (crewlogic-job-geofence-sync)
    // or via the end-of-day sweep — NOT here.
    eventType = ev.event_type === "geofence_exit" ? "job_leave" : "job_arrive";
    geofenceName = jobGeo.name; // no Motive name lookup needed — we created it
  } else if (ev.geofence_id != null) {
    const resolved = await resolveGeofenceName(sb, matched.uuid, ev.geofence_id);
    geofenceName = resolved.name;
    geofenceCategory = resolved.category;
  }

  const { error } = await sb.from("geofence_alerts").insert({
    franchise_id: matched.uuid, tenant_id: matched.tenant_id,
    action: ev.action, event_type: eventType,
    vehicle_id: ev.vehicle_id, vehicle_number: ev.vehicle_number,
    geofence_id: ev.geofence_id, geofence_name: geofenceName, category: geofenceCategory, event_id: ev.event_id,
    wo_id: jobGeo?.wo_id ?? null, job_id: jobGeo?.job_id ?? null, // Phase 3: clean per-job aggregation (no name parsing)
    start_time: ev.start_time, end_time: ev.end_time, duration: ev.duration,
    raw: parsed,
  });
  if (error) {
    console.error("[motive-webhook] insert failed:", error.message);
    return new Response(JSON.stringify({ ok: false, error: "store failed" }), { status: 500 });
  }

  console.log(`[motive-webhook] stored ${ev.action}/${eventType} veh=${ev.vehicle_number} f=${matched.external_id}${jobGeo ? " (job)" : ""}`);

  // FW-16: server-side auto-assign on the first arrival — so it happens without the board open. Uses the
  // fence's NUMERIC route_id (the route_truck_assignments key); job_geofences populated by the sync.
  if (eventType === "job_arrive" && jobGeo && jobGeo.route_id) {
    await autoAssignOnArrival(sb, matched.uuid, jobGeo.route_id, jobGeo.route, ev.vehicle_number);
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
});
