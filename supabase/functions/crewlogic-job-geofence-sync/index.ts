// Supabase Edge Function: crewlogic-job-geofence-sync (Phase A)
//
// For each of a franchise's jobs today, ensure a temporary Motive "Job Site" geofence
// exists so Motive fires geofence_entry/exit → crewlogic-motive-webhook stores an
// "arrived at / left <client>" alert. Idempotent: one ACTIVE job_geofences row per
// (franchise, work order); skips jobs already mapped.
//
// Reuses:
//   - crewlogic-todays-workorders (franchiseID = EXTERNAL id, e.g. "90"; includeCoords:true
//     returns cache-geocoded jobs: { workOrderID, jobID, clientName, address, lat, lon })
//   - crewlogic-geofence-create   (franchiseID = INTERNAL uuid; server-side Vault token +
//     Google geocode + Motive POST /v1/geofences/circular; delete via {action:'delete'})
//
// Request: { franchiseID (EXTERNAL, e.g. "90"), woID? (limit to one work order for testing),
//            dayOffset? (default 0), radius_in_meters? (default 75) }
// Response: { success, counts:{created,skipped,errors}, created[], skipped[], errors[] }
//
// Phase A note: this fn is the create/sync half. Delete-on-exit lives in the receiver
// (Phase B); a morning + ~30-60min cron drives this fn (Phase C).
//
// Deploy (DEV): supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-job-geofence-sync --use-api --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return j({ success: false, error: "Method not allowed" }, 405);

  try {
    const body = await req.json();
    const franchiseExternal = String(body.franchiseID || "").trim(); // external id, e.g. "90"
    const onlyWoID = body.woID ? String(body.woID) : null;           // limit to one WO (testing)
    const dayOffset = Number.isFinite(body.dayOffset) ? Number(body.dayOffset) : 0;
    const radius = Number.isFinite(body.radius_in_meters) ? Number(body.radius_in_meters) : 75;
    if (!franchiseExternal) return j({ success: false, error: "franchiseID (external) required" }, 400);

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // Resolve internal uuid + tenant for this franchise.
    const { data: fr } = await sb.from("franchises").select("id, tenant_id, external_id").eq("external_id", franchiseExternal).maybeSingle();
    if (!fr) return j({ success: false, error: "Franchise not found: " + franchiseExternal }, 404);
    const franchiseUuid = fr.id as string;
    const tenantId = fr.tenant_id as string | null;

    // Today's jobs (cache-geocoded).
    const wo = await callFn("crewlogic-todays-workorders", { franchiseID: franchiseExternal, includeCoords: true, dayOffset });
    if (!wo.ok || !wo.data?.success) return j({ success: false, error: "todays-workorders failed", detail: wo.data }, 502);
    let jobs: any[] = Array.isArray(wo.data.workOrders) ? wo.data.workOrders : [];
    if (onlyWoID) jobs = jobs.filter((x) => String(x.workOrderID) === onlyWoID);

    const created: any[] = [], skipped: any[] = [], errors: any[] = [];

    for (const job of jobs) {
      const woId = String(job.workOrderID || "");
      if (!woId) { errors.push({ error: "no workOrderID", job: job?.clientName || null }); continue; }
      const lat = Number(job.lat), lon = Number(job.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) { skipped.push({ woId, reason: "no geocode" }); continue; }

      // Idempotent: skip if an active geofence already maps this work order.
      const { data: existing } = await sb.from("job_geofences")
        .select("id, geofence_id").eq("franchise_id", franchiseUuid).eq("wo_id", woId).eq("status", "active").maybeSingle();
      if (existing) { skipped.push({ woId, reason: "already mapped", geofence_id: existing.geofence_id }); continue; }

      const name = (job.clientName || "Job") + " · #" + woId; // "<client> · #<woID>"

      // Create the Motive geofence (server-side Vault token + create).
      const gc = await callFn("crewlogic-geofence-create", {
        franchiseID: franchiseUuid, name, category: "Job Site",
        radius_in_meters: radius, centre_lat: lat, centre_lon: lon,
        address: job.address || "", description: "CrewLogic job geofence (auto)",
      });
      const gid = gc.data?.motive?.geofence?.id;
      if (!gc.ok || !gc.data?.success || !gid) { errors.push({ woId, error: "geofence create failed", detail: gc.data }); continue; }

      // Record the mapping.
      const { error: insErr } = await sb.from("job_geofences").insert({
        franchise_id: franchiseUuid, tenant_id: tenantId, wo_id: woId,
        job_id: job.jobID ? String(job.jobID) : null,
        vonigo_job_number: job.jobID ? String(job.jobID) : null,
        geofence_id: gid, name, centre_lat: lat, centre_lon: lon, status: "active",
      });
      if (insErr) { errors.push({ woId, error: "mapping insert failed", detail: insErr.message, geofence_id: gid }); continue; }

      created.push({ woId, geofence_id: gid, name });
    }

    return j({
      success: true, franchise: franchiseExternal,
      counts: { created: created.length, skipped: skipped.length, errors: errors.length },
      created, skipped, errors,
    });
  } catch (e) {
    console.error("[job-geofence-sync] error:", (e as Error).message);
    return j({ success: false, error: "sync failed" }, 500);
  }
});
