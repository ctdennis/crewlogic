// Supabase Edge Function: crewlogic-recycling
//
// Recycling revenue: list visits needing an amount, record what was collected, and report.
// Contract: docs/contract-recycling-revenue.md
//
// WHAT THIS REPLACES
// Owner currently reads outstanding revenue off a Google Sheet: recycling rows are coloured
// green and scanned for any green row without an amount. That is the check this automates, and
// the bar it has to clear. Part of retiring MailParser (~$200/mo).
//
// MODEL — presence is the signal (migration 0062)
//   a visit_settlements row EXISTS → collected
//   no row                          → still to collect
// So `amount` is NOT NULL. Zero and negatives are real: Owner's history contains a 0 ("collected
// nothing") and a -80 ("the recycler charged me"). There is deliberately no `collected` boolean —
// Owner: "I only enter the amount when I have cash in hand."
//
// VISITS come from geofence_alerts (event_type=geofence_exit, duration not null), joined to
// facilities on (franchise_id, provider_geofence_id). That join is why facilities are keyed on
// the stable geofence id rather than a name — a facility renamed or reclassified in Motive keeps
// its history and its money attached.
//
// Actions:
//   listVisits       - recycling visits with settlement state; filters: status, facility, range
//   saveSettlement   - record/update amount + weight for one visit
//   deleteSettlement - undo a settlement (returns the visit to "still to collect")
//   summary          - collected totals by period + outstanding count
//
// Deploy (DEV):
//   supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-recycling --use-api --no-verify-jwt

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// A stop under 8 minutes at a fence is a drive-through / false positive. Same threshold the
// Alerts Report uses (index.html MIN_SEC) — the two surfaces must agree on what a visit is, or
// the revenue screen and the report will disagree about how many visits happened.
const MIN_VISIT_SEC = 480;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function sb(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

// Resolve the caller's franchise from external_id. Every query is scoped to it.
async function resolveFranchise(db: SupabaseClient, franchiseID: string): Promise<{ id: string } | null> {
  if (!franchiseID) return null;
  // Accept either the external id ("90") or the internal uuid, since callers vary.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(franchiseID);
  const q = isUuid
    ? db.from("franchises").select("id").eq("id", franchiseID)
    : db.from("franchises").select("id").eq("external_id", franchiseID);
  const { data } = await q.maybeSingle();
  return data ? { id: data.id as string } : null;
}

// Every page of a PostgREST query. The 1000-row cap applies regardless of .limit(), and a
// truncated read here would silently under-report revenue.
async function pageAll(build: (from: number, to: number) => any): Promise<any[]> {
  const PAGE = 1000;
  let out: any[] = [];
  for (let from = 0; from < 50000; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const arr = data || [];
    out = out.concat(arr);
    if (arr.length < PAGE) break;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "listVisits");
    const db = sb();

    const fr = await resolveFranchise(db, String(body.franchiseID || ""));
    if (!fr) return json({ success: false, error: "franchise not found" }, 404);

    // ── Recycling facilities for this franchise, keyed by geofence id ──────────────────────
    const { data: facRows, error: facErr } = await db
      .from("facilities")
      .select("id,name,type,provider,provider_geofence_id")
      .eq("franchise_id", fr.id)
      .eq("type", "recycling")
      .not("provider_geofence_id", "is", null);
    if (facErr) return json({ success: false, error: "facilities lookup failed" }, 500);

    const facByGeofence = new Map<string, { id: string; name: string }>();
    for (const f of (facRows || [])) {
      facByGeofence.set(String(f.provider_geofence_id), { id: f.id as string, name: (f.name as string) || "" });
    }
    const geofenceIds = Array.from(facByGeofence.keys()).map(Number);

    if (action === "facilities") {
      return json({
        success: true,
        facilities: (facRows || []).map((f) => ({
          id: f.id, name: f.name, geofenceId: String(f.provider_geofence_id),
        })),
      });
    }

    // No linked recycling facility → nothing to show. Say so explicitly rather than returning an
    // empty list that reads as "no visits", which would send someone hunting for missing data.
    if (!geofenceIds.length) {
      return json({
        success: true, visits: [], summary: null, unlinked: true,
        message: "No recycling facilities are linked to a telematics geofence yet. Link them in Settings → Cost → Facilities.",
      });
    }

    // ── Visits: completed dwells at those geofences ───────────────────────────────────────
    const fromIso = body.from ? new Date(String(body.from)).toISOString() : null;
    const toIso = body.to ? new Date(String(body.to)).toISOString() : null;

    const visits = await pageAll((from, to) => {
      let q = db.from("geofence_alerts")
        .select("id,geofence_id,geofence_name,vehicle_number,duration,start_time,end_time,created_at,event_id,action")
        .eq("franchise_id", fr.id)
        .eq("event_type", "geofence_exit")
        .not("duration", "is", null)
        .gte("duration", MIN_VISIT_SEC)
        .in("geofence_id", geofenceIds)
        .order("created_at", { ascending: false })
        .range(from, to);
      if (fromIso) q = q.gte("created_at", fromIso);
      if (toIso) q = q.lte("created_at", toIso);
      return q;
    });

    // ── Settlements for those visits ──────────────────────────────────────────────────────
    const settlements = await pageAll((from, to) =>
      db.from("visit_settlements")
        .select("id,alert_id,amount,weight_lbs,settled_at,note")
        .eq("franchise_id", fr.id)
        .range(from, to));
    const settByAlert = new Map<string, any>();
    for (const s of settlements) if (s.alert_id != null) settByAlert.set(String(s.alert_id), s);

    const rows = visits.map((v) => {
      const s = settByAlert.get(String(v.id)) || null;
      const fac = facByGeofence.get(String(v.geofence_id));
      return {
        alertId: v.id,
        eventId: v.event_id != null ? String(v.event_id) : null,
        geofenceId: String(v.geofence_id),
        facilityName: fac ? fac.name : (v.geofence_name || "(unknown)"),
        geofenceName: v.geofence_name,
        truck: v.vehicle_number,
        startedAt: v.start_time || v.created_at,
        durationSec: v.duration,
        settled: !!s,
        amount: s ? Number(s.amount) : null,
        weightLbs: s && s.weight_lbs != null ? Number(s.weight_lbs) : null,
        settledAt: s ? s.settled_at : null,
        note: s ? s.note : null,
      };
    });

    if (action === "listVisits") {
      const status = String(body.status || "all");     // all | outstanding | collected
      const facilityGeofenceId = String(body.geofenceId || "");
      let out = rows;
      if (status === "outstanding") out = out.filter((r) => !r.settled);
      else if (status === "collected") out = out.filter((r) => r.settled);
      if (facilityGeofenceId) out = out.filter((r) => r.geofenceId === facilityGeofenceId);
      return json({
        success: true,
        visits: out,
        totals: {
          all: rows.length,
          outstanding: rows.filter((r) => !r.settled).length,
          collected: rows.filter((r) => r.settled).length,
        },
      });
    }

    if (action === "summary") {
      // Collected totals per period + what is still to collect. No aging, no overdue — Owner:
      // "timing doesn't matter, I'm not looking for DSO or anything like an aging report."
      const collected = rows.filter((r) => r.settled);
      const byPeriod: Record<string, { key: string; amount: number; weight: number; visits: number }> = {};
      const grain = String(body.grain || "month");   // day | week | month | year
      const keyOf = (iso: string) => {
        const d = new Date(iso);
        if (grain === "day") return d.toISOString().slice(0, 10);
        if (grain === "year") return String(d.getUTCFullYear());
        if (grain === "week") {
          const t = new Date(d); t.setUTCDate(t.getUTCDate() - t.getUTCDay());
          return t.toISOString().slice(0, 10);
        }
        return d.toISOString().slice(0, 7);
      };
      for (const r of collected) {
        const k = keyOf(r.startedAt);
        const b = byPeriod[k] || (byPeriod[k] = { key: k, amount: 0, weight: 0, visits: 0 });
        b.amount += r.amount || 0;
        b.weight += r.weightLbs || 0;
        b.visits += 1;
      }
      const byFacility: Record<string, { name: string; amount: number; weight: number; collected: number; outstanding: number }> = {};
      for (const r of rows) {
        const b = byFacility[r.facilityName] || (byFacility[r.facilityName] = { name: r.facilityName, amount: 0, weight: 0, collected: 0, outstanding: 0 });
        if (r.settled) { b.amount += r.amount || 0; b.weight += r.weightLbs || 0; b.collected += 1; }
        else b.outstanding += 1;
      }
      return json({
        success: true,
        grain,
        totalCollected: collected.reduce((a, r) => a + (r.amount || 0), 0),
        totalWeightLbs: collected.reduce((a, r) => a + (r.weightLbs || 0), 0),
        collectedVisits: collected.length,
        outstandingVisits: rows.length - collected.length,
        byPeriod: Object.values(byPeriod).sort((a, b) => a.key < b.key ? 1 : -1),
        byFacility: Object.values(byFacility).sort((a, b) => b.amount - a.amount),
      });
    }

    if (action === "saveSettlement") {
      const alertId = body.alertId;
      if (alertId == null) return json({ success: false, error: "alertId required" }, 400);
      // amount must be an explicit number. Reject blank/NaN rather than coercing to 0 — 0 is a
      // REAL value here ("collected nothing"), so silently turning a mistyped field into 0 would
      // record a false settlement that looks deliberate.
      const rawAmount = body.amount;
      const amount = typeof rawAmount === "number" ? rawAmount : parseFloat(String(rawAmount ?? ""));
      if (!Number.isFinite(amount)) return json({ success: false, error: "amount must be a number (0 is allowed)" }, 400);
      const rawWeight = body.weightLbs;
      const weight = (rawWeight === "" || rawWeight == null) ? null : parseFloat(String(rawWeight));
      if (weight != null && !Number.isFinite(weight)) return json({ success: false, error: "weightLbs must be a number or blank" }, 400);

      const visit = visits.find((v) => String(v.id) === String(alertId));
      if (!visit) return json({ success: false, error: "visit not found for this franchise" }, 404);

      const row = {
        franchise_id: fr.id,
        alert_id: visit.id,
        provider: "motive",
        provider_event_id: visit.event_id != null ? String(visit.event_id) : null,
        provider_geofence_id: visit.geofence_id,
        visit_started_at: visit.start_time || visit.created_at,
        amount,
        weight_lbs: weight,
        settled_at: new Date().toISOString(),
        settled_by: body.profileId || null,
        note: body.note ? String(body.note) : null,
      };
      const { error } = await db.from("visit_settlements")
        .upsert(row, { onConflict: "franchise_id,alert_id" });
      if (error) {
        console.error("[recycling] saveSettlement failed:", error.message);
        return json({ success: false, error: "could not save" }, 500);
      }
      return json({ success: true, alertId: visit.id, amount, weightLbs: weight });
    }

    if (action === "deleteSettlement") {
      const alertId = body.alertId;
      if (alertId == null) return json({ success: false, error: "alertId required" }, 400);
      const { error } = await db.from("visit_settlements")
        .delete().eq("franchise_id", fr.id).eq("alert_id", alertId);
      if (error) return json({ success: false, error: "could not delete" }, 500);
      return json({ success: true, alertId });
    }

    return json({ success: false, error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error("[recycling] error:", (e as Error).message);
    return json({ success: false, error: "request failed" }, 500);
  }
});
