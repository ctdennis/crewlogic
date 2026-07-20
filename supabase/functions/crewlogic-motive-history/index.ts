// Supabase Edge Function: crewlogic-motive-history
//
// READ-ONLY probe against Motive's historical geofence-events endpoint.
//
// WHY THIS EXISTS
// CrewLogic's own `geofence_alerts` starts 2026-07-02 (the prod webhook cutover). The owner has
// hand-maintained history back to 2025-11-07 in a spreadsheet fed by MailParser. Before deciding
// whether to import that spreadsheet or backfill from source, we need to know ONE thing that
// Motive's docs do not state in either direction: how far back `/v1/geofences/events` will
// actually return data. Motive documents `start_date`/`end_date` params but NO retention limit
// and no earliest-available date, so this can only be settled empirically.
//
// It also answers two things the docs leave undocumented and that a real import depends on:
//   - the TIMESTAMP FORMAT / timezone convention on start_time & end_time
//   - the `event_type` enum values
//
// SCOPE: this function ONLY READS. It performs no inserts, updates or deletes, and writes
// nothing to the database. It is deliberately a probe, not the importer — the importer is a
// separate build gated on what this returns.
//
// Deploy (DEV):
//   supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-motive-history --use-api --no-verify-jwt
//
// AUTH: SUPER-ADMIN ONLY. Deployed --no-verify-jwt (gateway open) with the check performed in
// the handler, matching crewlogic-quickbooks / crewlogic-card-transactions. Every request must
// carry the super-admin's Supabase JWT; anything else — including the publishable anon key —
// gets 403 before the body is read or any credential is touched.
//
// POST body (probe):
//   { franchiseID: "<franchise UUID>",   // franchises.id, NOT external_id
//     startDate:  "2025-11-01",
//     endDate:    "2025-11-30",
//     geofenceIds?: [2892241],           // optional filter
//     pageNo?: 1, perPage?: 25 }
//
// POST body (import — writes to geofence_alerts):
//   { action: "import", franchiseID, startDate, endDate, dryRun?: true }
//
// ── IMPORT DESIGN NOTES ──────────────────────────────────────────────────────────────────
// Rows are written into the EXISTING geofence_alerts table so the Alerts Report picks them up
// with no schema change. Three details are load-bearing:
//
//   action = 'motive_backfill'
//     Existing rows use 'vehicle_geofence_event' (Motive live), 'linxup_fence_event' or
//     'lifecycle'. A distinct value makes the whole backfill exactly identifiable, so backing
//     it out is one statement:
//         delete from geofence_alerts where action = 'motive_backfill';
//     The report does NOT filter on action, so these still appear.
//
//   event_type = 'geofence_exit'
//     The Alerts Report queries event_type=eq.geofence_exit AND duration not null. Anything
//     else is invisible to it. Motive's history records ARE completed dwells, so exit is the
//     honest mapping.
//
//   created_at = the event's start_time, NOT now()
//     This one matters most. created_at is what Live Alerts orders by and what the report's
//     range filter uses (index.html:4417). Inserting 1800+ historic rows stamped "now" would
//     flood the live alert feed with months-old events presented as current, and dump every
//     one of them into "Today" on the report. Stamping the visit time keeps both correct.
//
// Idempotent by event_id: Motive's numeric event id is stored in geofence_alerts.event_id, and
// any id already present for this franchise is skipped. Re-running the same range inserts
// nothing. (There is no unique constraint on event_id — Linxup rows legitimately have none —
// so dedupe is done in code rather than relying on ON CONFLICT.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MOTIVE_BASE = "https://api.gomotive.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// ── SUPER-ADMIN GATE ─────────────────────────────────────────────────────────────────────
// This function reads a franchise's full telematics history and WRITES to geofence_alerts.
// It is an operational backfill tool, not a customer-facing feature, so it is restricted to
// the super-admin rather than merely franchise-scoped.
//
// Deployed --no-verify-jwt (the gateway lets the request through) with the check done here,
// matching crewlogic-quickbooks and crewlogic-card-transactions. Same pattern, same email, so
// there is one super-admin mechanism in the codebase rather than two.
//
// Before this existed the function was reachable by anyone holding the publishable anon key —
// which is embedded in the frontend and therefore public. Given a franchise UUID, that exposed
// nine months of vehicle movement, and the import action could write rows.
const SUPER_ADMIN_EMAIL = "charles.dennis@junkluggers.com";
async function isSuperAdmin(req: Request): Promise<boolean> {
  try {
    const tokenHdr = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!tokenHdr) return false;
    const r = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + tokenHdr, apikey: SERVICE_KEY },
    });
    if (!r.ok) return false;                       // anon/publishable key resolves to no user → denied
    const u = await r.json();
    return String(u?.email || "").toLowerCase() === SUPER_ADMIN_EMAIL;
  } catch (_e) { return false; }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Pull every page of /v1/geofences/events for a range. Returns raw event objects.
async function fetchAllEvents(token: string, startDate: string, endDate: string): Promise<any[]> {
  const out: any[] = [];
  const perPage = 100;
  for (let page = 1; page <= 100; page++) {   // hard stop: 10k events, far above any real range
    const qs = new URLSearchParams();
    qs.set("start_date", startDate);
    if (endDate) qs.set("end_date", endDate);
    qs.set("page_no", String(page));
    qs.set("per_page", String(perPage));
    const res = await fetch(`${MOTIVE_BASE}/v1/geofences/events?${qs.toString()}`, {
      headers: { accept: "application/json", "x-api-key": token },
    });
    if (!res.ok) throw new Error(`motive ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const listRaw: any[] = Array.isArray(data) ? data : (data.geofence_events || data.events || []);
    const events = listRaw.map((it) => (it && (it.geofence_event || it.event)) || it).filter(Boolean);
    out.push(...events);
    if (events.length < perPage) break;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Gate BEFORE reading the body or touching credentials — nothing happens for a non-admin.
  if (!(await isSuperAdmin(req))) {
    return json({ success: false, error: "forbidden" }, 403);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const franchiseID = String(body.franchiseID || "");
    const startDate = String(body.startDate || "");
    const endDate = String(body.endDate || "");
    const pageNo = Number(body.pageNo) || 1;
    const perPage = Number(body.perPage) || 25;
    const geofenceIds: unknown[] = Array.isArray(body.geofenceIds) ? body.geofenceIds : [];

    if (!franchiseID) return json({ success: false, error: "franchiseID (uuid) required" }, 400);
    if (!startDate) return json({ success: false, error: "startDate (YYYY-MM-DD) required" }, 400);

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Per-franchise Motive token, same path the webhook uses to resolve geofence names.
    const { data: cred, error: credErr } = await sb.rpc("get_telematics_credential", { p_franchise_id: franchiseID });
    if (credErr) return json({ success: false, error: "credential lookup failed: " + credErr.message }, 500);
    const row = Array.isArray(cred) ? cred[0] : cred;
    const provider = String(row?.provider || "").toLowerCase();
    const token = String(row?.token || "");
    if (provider !== "motive" || !token) {
      return json({ success: false, error: `no motive credential for this franchise (provider=${provider || "none"})` }, 400);
    }

    // ── IMPORT: write completed dwells into geofence_alerts ──────────────────────────────
    if (String(body.action || "") === "import") {
      const dryRun = body.dryRun === true;

      // Franchise context (tenant_id matches how the live webhook writes its rows).
      const { data: fr } = await sb.from("franchises").select("tenant_id").eq("id", franchiseID).maybeSingle();
      const tenantId = fr?.tenant_id ?? null;

      // Geofence id → { name, category }, from the cache the webhook already maintains.
      const { data: gfRows } = await sb
        .from("motive_geofences").select("geofence_id, name, category").eq("franchise_id", franchiseID);
      const gfMap = new Map<string, { name: string | null; category: string | null }>();
      for (const g of (gfRows || [])) {
        gfMap.set(String(g.geofence_id), { name: g.name ?? null, category: g.category ?? null });
      }

      const events = await fetchAllEvents(token, startDate, endDate);

      // Skip anything already stored for this franchise.
      //
      // ⚠ Query ONLY the ids we are about to insert, in chunks. The obvious version —
      // "select event_id where franchise_id = X" — silently truncates at PostgREST's default
      // 1000-row cap, so on a re-run it saw ~1000 of 1835 stored ids and re-inserted the other
      // 835 as duplicates. Bounding the query by the incoming ids makes it exact regardless of
      // how much history is already stored.
      const incomingIds = events.map((e) => e?.id).filter((v) => v != null).map((v) => String(v));
      const seen = new Set<string>();
      for (let i = 0; i < incomingIds.length; i += 300) {
        const chunk = incomingIds.slice(i, i + 300);
        const { data: hit, error } = await sb
          .from("geofence_alerts").select("event_id")
          .eq("franchise_id", franchiseID).in("event_id", chunk);
        if (error) return json({ success: false, error: `dedupe lookup failed: ${error.message}` }, 500);
        for (const r of (hit || [])) seen.add(String((r as any).event_id));
      }

      const rows: Record<string, unknown>[] = [];
      let skipped = 0, noId = 0;
      for (const e of events) {
        const eid = e?.id;
        if (eid == null) { noId++; continue; }
        if (seen.has(String(eid))) { skipped++; continue; }
        seen.add(String(eid));                       // guard against dupes within the same pull
        const gf = gfMap.get(String(e.geofence_id)) || { name: null, category: null };
        rows.push({
          franchise_id: franchiseID,
          tenant_id: tenantId,
          action: "motive_backfill",                 // the backout handle — see header
          event_type: "geofence_exit",               // what the Alerts Report filters on
          vehicle_id: e?.vehicle?.id ?? null,
          vehicle_number: e?.vehicle?.number ?? null,
          geofence_id: e?.geofence_id ?? null,
          geofence_name: gf.name,
          category: gf.category,
          event_id: eid,
          start_time: e?.start_time ?? null,
          end_time: e?.end_time ?? null,
          duration: e?.duration ?? null,
          // The visit time, NOT now(). Stamping now() would flood Live Alerts with months-old
          // events shown as current and dump them all into "Today" on the report.
          created_at: e?.start_time ?? null,
          raw: e,
        });
      }

      if (dryRun) {
        return json({
          success: true, dryRun: true,
          fetched: events.length, wouldInsert: rows.length, alreadyPresent: skipped, missingEventId: noId,
          unresolvedGeofenceNames: rows.filter((r) => r.geofence_name == null).length,
          earliest: rows.length ? rows.map((r) => r.start_time).sort()[0] : null,
          latest: rows.length ? rows.map((r) => r.start_time).sort().slice(-1)[0] : null,
          sample: rows[0] ?? null,
        });
      }

      let inserted = 0;
      for (let i = 0; i < rows.length; i += 400) {
        const chunk = rows.slice(i, i + 400);
        const { error } = await sb.from("geofence_alerts").insert(chunk);
        if (error) {
          console.error("[motive-history] insert failed at offset", i, error.message);
          return json({ success: false, inserted, error: `insert failed at ${i}: ${error.message}` }, 500);
        }
        inserted += chunk.length;
      }

      return json({
        success: true,
        fetched: events.length, inserted, alreadyPresent: skipped, missingEventId: noId,
        unresolvedGeofenceNames: rows.filter((r) => r.geofence_name == null).length,
        backoutSql: "delete from geofence_alerts where franchise_id = '" + franchiseID + "' and action = 'motive_backfill';",
      });
    }

    const qs = new URLSearchParams();
    qs.set("start_date", startDate);
    if (endDate) qs.set("end_date", endDate);
    qs.set("page_no", String(pageNo));
    qs.set("per_page", String(perPage));
    for (const g of geofenceIds) qs.append("geofence_ids[]", String(g));

    const url = `${MOTIVE_BASE}/v1/geofences/events?${qs.toString()}`;
    const res = await fetch(url, { headers: { accept: "application/json", "x-api-key": token } });
    const text = await res.text();

    if (!res.ok) {
      console.error("[motive-history] upstream", res.status, text.slice(0, 500));
      return json({ success: false, upstreamStatus: res.status, error: text.slice(0, 500), requestedUrl: url.replace(/x-api-key=[^&]*/, "") }, 502);
    }

    let data: any = {};
    try { data = JSON.parse(text); } catch { return json({ success: false, error: "non-JSON upstream response", sample: text.slice(0, 300) }, 502); }

    // Motive wraps list items; tolerate either a bare array or {geofence_events:[{geofence_event:{...}}]}.
    const listRaw: any[] = Array.isArray(data) ? data : (data.geofence_events || data.events || []);
    const events = listRaw.map((it) => (it && (it.geofence_event || it.event)) || it).filter(Boolean);

    // Summarize rather than dump: we want shape + range, not the payload.
    const times = events.map((e) => e?.start_time).filter(Boolean).sort();
    const fieldNames = events.length ? Object.keys(events[0]) : [];
    const eventTypes = Array.from(new Set(events.map((e) => e?.event_type).filter(Boolean)));
    const withDuration = events.filter((e) => e?.duration != null).length;
    const withGeofenceId = events.filter((e) => e?.geofence_id != null).length;

    return json({
      success: true,
      requested: { startDate, endDate, pageNo, perPage },
      pagination: data.pagination ?? null,
      returned: events.length,
      earliestStartTime: times[0] ?? null,
      latestStartTime: times[times.length - 1] ?? null,
      // The two things the docs do not state:
      timestampSample: events[0]?.start_time ?? null,
      eventTypeValues: eventTypes,
      // Shape confirmation for the importer
      topLevelFields: fieldNames,
      vehicleFields: events[0]?.vehicle ? Object.keys(events[0].vehicle) : [],
      withDuration,
      withGeofenceId,
      firstEvent: events[0] ?? null,
    });
  } catch (e) {
    console.error("[motive-history] error:", (e as Error).message);
    return json({ success: false, error: "probe failed" }, 500);
  }
});
