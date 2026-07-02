// Supabase Edge Function: crewlogic-job-geofence-sync (Phase C — lifecycle manager)
//
// Manages the per-job Motive "Job Site" geofences end-to-end:
//   CREATE        — for each of today's Vonigo jobs, ensure a Motive geofence exists so Motive fires
//                   geofence_entry/exit → crewlogic-motive-webhook stores "arrived at / left <client>".
//   DELETE-ON-DONE — when a WO is marked done (Completed/Archived, or a "done" label), delete its geofence.
//   EOD SWEEP     — action:'sweep' deletes every still-active geofence (end-of-day backstop; also cleans
//                   up cancelled/no-show jobs that lingered).
//
// A truck LEAVING is NEVER a delete signal. Multi-truck jobs have trucks arrive/leave/return
// (dump-and-come-back) in ANY order, so the geofence must persist for the whole job. Deletion is
// driven ONLY by Vonigo WO "done" status here + the EOD sweep — never by an exit event.
//
// SAFETY: we delete on EXPLICIT done (isComplete || labelDone) only — NOT on "missing from today's
// list". A transient crewlogic-todays-workorders hiccup returning a short list must never wrongly
// delete active jobs' geofences (that would silently stop tracking arrivals for the rest of the day).
// Cancelled / dropped / no-show jobs are cleaned by the EOD sweep instead.
//
// Idempotent: one row per (franchise, wo) per day (ANY status, 20h window) — a geofence deleted on
// done is not re-created by a later same-day cron run.
//
// Reuses:
//   - crewlogic-todays-workorders (franchiseID = EXTERNAL id; includeCoords:true → cache-geocoded
//     jobs incl. { workOrderID, jobID, clientName, address, lat, lon, isComplete, labelDone })
//   - crewlogic-geofence-create   (franchiseID = INTERNAL uuid; Vault token + Motive create/delete)
//
// Request:
//   {}                                          → sync ALL eligible franchises (have a Motive credential)
//   { franchiseID:"90" }                        → sync one franchise (create + delete-on-done)
//   { franchiseID:"90", woID, dayOffset, radius_in_meters } → targeted create-only (testing; no delete pass)
//   { action:"sweep" }                          → EOD sweep ALL eligible franchises
//   { action:"sweep", franchiseID:"90" }        → EOD sweep one franchise
//
// Deploy (DEV): supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-job-geofence-sync --use-api --no-verify-jwt

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function j(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
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

type Fr = { id: string; external_id: string; tenant_id: string | null };

// Franchises eligible for job geofences: those with a Motive telematics credential. Non-Vonigo ones
// simply return zero jobs from crewlogic-todays-workorders, so iterating them is harmless.
async function eligibleFranchises(sb: SupabaseClient): Promise<Fr[]> {
  const { data: creds } = await sb.from("telematics_credentials").select("franchise_id").ilike("provider", "motive");
  const ids = [...new Set((creds || []).map((c: any) => c.franchise_id).filter(Boolean))];
  if (!ids.length) return [];
  const { data: frs } = await sb.from("franchises").select("id, external_id, tenant_id").in("id", ids);
  return (frs || []) as Fr[];
}

async function resolveFranchise(sb: SupabaseClient, external: string): Promise<Fr | null> {
  const { data } = await sb.from("franchises").select("id, external_id, tenant_id").eq("external_id", external).maybeSingle();
  return (data as Fr) || null;
}

// Lifecycle notification into the same alerts list the truck crossings use (📍 created / 🏁 deleted).
// These are NOT Motive webhook events — WE generate them so the list reads as a full per-job lifecycle.
// Best-effort: a failed insert must never break the create/delete it accompanies.
async function insertLifecycleAlert(
  sb: SupabaseClient,
  fr: Fr,
  ev: { event_type: string; geofence_id: any; geofence_name: string | null; raw?: unknown },
): Promise<void> {
  try {
    await sb.from("geofence_alerts").insert({
      franchise_id: fr.id, tenant_id: fr.tenant_id,
      action: "lifecycle", event_type: ev.event_type,
      vehicle_id: null, vehicle_number: null,
      geofence_id: ev.geofence_id, geofence_name: ev.geofence_name,
      raw: ev.raw ?? null,
    });
  } catch (e) {
    console.error("[job-geofence-sync] lifecycle alert insert failed:", (e as Error).message);
  }
}

async function deleteGeofence(
  sb: SupabaseClient,
  fr: Fr,
  row: { id: string; geofence_id: any; name?: string | null },
  reason: string, // 'job_complete' | 'eod'
): Promise<string | null> {
  // Returns null on success, or an error string. Best-effort: always marks the row deleted so the
  // mapping stops matching (EOD sweep re-attempts nothing; the Motive geofence delete is best-effort).
  let err: string | null = null;
  try {
    const del = await callFn("crewlogic-geofence-create", { action: "delete", franchiseID: fr.id, geofence_id: row.geofence_id });
    if (!del.ok || !del.data?.success) err = "motive delete failed: " + JSON.stringify(del.data).slice(0, 160);
  } catch (e) {
    err = "motive delete error: " + (e as Error).message;
  }
  await sb.from("job_geofences").update({ status: "deleted", deleted_at: new Date().toISOString() }).eq("id", row.id);
  // 🏁/🌙 "Tracking ended" notification in the alerts list.
  await insertLifecycleAlert(sb, fr, { event_type: "geofence_deleted", geofence_id: row.geofence_id, geofence_name: row.name ?? null, raw: { reason } });
  return err;
}

// Town/city from a Vonigo multi-line address ("street\ncity, ST zip"). Returns the city segment —
// the comma-part just before "STATE ZIP" — best-effort for US addresses; "" when unparseable.
function townFromAddress(addr: string): string {
  if (!addr) return "";
  const parts = String(addr).replace(/\n/g, ",").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length && /^(usa|united states)$/i.test(parts[parts.length - 1])) parts.pop();
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

// CREATE + DELETE-ON-DONE for one franchise.
async function syncFranchise(
  sb: SupabaseClient,
  fr: Fr,
  opts: { onlyWoID: string | null; dayOffset: number; radius: number },
): Promise<any> {
  const { onlyWoID, dayOffset, radius } = opts;
  const created: any[] = [], skipped: any[] = [], errors: any[] = [], deleted: any[] = [];

  const wo = await callFn("crewlogic-todays-workorders", { franchiseID: fr.external_id, includeCoords: true, dayOffset });
  if (!wo.ok || !wo.data?.success) {
    // Do NOT run the delete pass on a failed/empty fetch — that could wrongly delete active geofences.
    return { franchise: fr.external_id, error: "todays-workorders failed", counts: { created: 0, skipped: 0, errors: 1, deleted: 0 }, detail: wo.data };
  }
  const allJobs: any[] = Array.isArray(wo.data.workOrders) ? wo.data.workOrders : [];

  // ---- CREATE pass ----
  const createJobs = onlyWoID ? allJobs.filter((x) => String(x.workOrderID) === String(onlyWoID)) : allJobs;
  for (const job of createJobs) {
    const woId = String(job.workOrderID || "");
    if (!woId) { errors.push({ error: "no workOrderID", job: job?.clientName || null }); continue; }
    const lat = Number(job.lat), lon = Number(job.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { skipped.push({ woId, reason: "no geocode" }); continue; }

    // Don't geofence a job that's already done — no arrivals to track. (A job that becomes done AFTER
    // its geofence is created is handled by the delete-on-done pass below.)
    if (job.isComplete || job.labelDone) { skipped.push({ woId, reason: "already done" }); continue; }

    // Idempotent: skip if this WO already has a job_geofences row from today's cycle — ANY status
    // (active OR deleted). A geofence deleted-on-done must NOT be re-created by a later same-day run.
    const cutoffISO = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
    const { data: existing } = await sb.from("job_geofences")
      .select("id, geofence_id, status").eq("franchise_id", fr.id).eq("wo_id", woId)
      .gte("created_at", cutoffISO).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (existing) { skipped.push({ woId, reason: "already handled today (" + existing.status + ")", geofence_id: existing.geofence_id }); continue; }

    const town = townFromAddress(job.address || "");
    const name = (job.clientName || "Job") + " · #" + woId + (town ? " · " + town : ""); // "<client> · #<woID> · <town>"
    const gc = await callFn("crewlogic-geofence-create", {
      franchiseID: fr.id, name, category: "Job Site",
      radius_in_meters: radius, centre_lat: lat, centre_lon: lon,
      address: job.address || "", description: "CrewLogic job geofence (auto)",
    });
    const gid = gc.data?.motive?.geofence?.id;
    if (!gc.ok || !gc.data?.success || !gid) { errors.push({ woId, error: "geofence create failed", detail: gc.data }); continue; }

    const { error: insErr } = await sb.from("job_geofences").insert({
      franchise_id: fr.id, tenant_id: fr.tenant_id, wo_id: woId,
      job_id: job.jobID ? String(job.jobID) : null,
      vonigo_job_number: job.jobID ? String(job.jobID) : null,
      geofence_id: gid, name, centre_lat: lat, centre_lon: lon, status: "active",
    });
    if (insErr) { errors.push({ woId, error: "mapping insert failed", detail: insErr.message, geofence_id: gid }); continue; }
    created.push({ woId, geofence_id: gid, name });
    // 📍 "Tracking started" notification — fires once per job/day (idempotent create above prevents dupes).
    await insertLifecycleAlert(sb, fr, { event_type: "geofence_created", geofence_id: gid, geofence_name: name, raw: { reason: "created", woId } });
  }

  // ---- DELETE-ON-DONE pass (skip for a targeted create-only test) ----
  // Delete a job's geofence when its WO is EXPLICITLY done (Completed/Archived, or a "done" label —
  // the same gray rule the dispatch board uses, surfaced by todays-workorders as isComplete/labelDone).
  // We do NOT delete on "missing from list" — the EOD sweep handles cancelled/dropped/no-shows safely.
  if (!onlyWoID) {
    const doneByWo = new Map<string, boolean>();
    for (const job of allJobs) {
      const w = String(job.workOrderID || ""); if (!w) continue;
      doneByWo.set(w, !!(job.isComplete || job.labelDone));
    }
    const { data: activeRows } = await sb.from("job_geofences")
      .select("id, wo_id, geofence_id, name").eq("franchise_id", fr.id).eq("status", "active");
    for (const row of activeRows || []) {
      const w = String(row.wo_id);
      if (doneByWo.get(w) !== true) continue; // only delete WOs seen as done in this fetch
      const err = await deleteGeofence(sb, fr, row, "job_complete");
      if (err) errors.push({ woId: w, error: "delete-on-done", detail: err });
      deleted.push({ woId: w, geofence_id: row.geofence_id, reason: "done" });
    }
  }

  return {
    franchise: fr.external_id,
    counts: { created: created.length, skipped: skipped.length, errors: errors.length, deleted: deleted.length },
    created, skipped, errors, deleted,
  };
}

// EOD sweep: delete EVERY still-active geofence for the franchise (backstop for done-misses, cancelled,
// no-shows, and anything the day left behind).
async function sweepFranchise(sb: SupabaseClient, fr: Fr): Promise<any> {
  const errors: any[] = [];
  let deleted = 0;
  const { data: activeRows } = await sb.from("job_geofences")
    .select("id, wo_id, geofence_id, name").eq("franchise_id", fr.id).eq("status", "active");
  for (const row of activeRows || []) {
    const err = await deleteGeofence(sb, fr, row, "eod");
    if (err) errors.push({ woId: row.wo_id, detail: err });
    deleted++;
  }
  return { franchise: fr.external_id, counts: { deleted, errors: errors.length }, errors };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return j({ success: false, error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "").trim();          // "sweep" | ""
    const franchiseExternal = body.franchiseID ? String(body.franchiseID).trim() : "";
    const onlyWoID = body.woID ? String(body.woID) : null;
    const dayOffset = Number.isFinite(body.dayOffset) ? Number(body.dayOffset) : 0;
    const radius = Number.isFinite(body.radius_in_meters) ? Number(body.radius_in_meters) : 75;

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // Target franchise(s): one if franchiseID given, else all eligible (Motive credential).
    let targets: Fr[];
    if (franchiseExternal) {
      const fr = await resolveFranchise(sb, franchiseExternal);
      if (!fr) return j({ success: false, error: "Franchise not found: " + franchiseExternal }, 404);
      targets = [fr];
    } else {
      targets = await eligibleFranchises(sb);
    }

    const results: any[] = [];
    for (const fr of targets) {
      try {
        results.push(action === "sweep"
          ? await sweepFranchise(sb, fr)
          : await syncFranchise(sb, fr, { onlyWoID, dayOffset, radius }));
      } catch (e) {
        results.push({ franchise: fr.external_id, error: (e as Error).message });
      }
    }

    return j({ success: true, action: action || "sync", franchises: targets.length, results });
  } catch (e) {
    console.error("[job-geofence-sync] error:", (e as Error).message);
    return j({ success: false, error: "sync failed" }, 500);
  }
});
