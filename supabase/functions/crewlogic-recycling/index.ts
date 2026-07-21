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

    // ── Revenue-earning recycling facilities for this franchise, keyed by geofence id ──────
    // settlement_mode is the gate, NOT type alone (migration 0063). Only metal recyclers pay
    // us; mattress / electronics / tire recyclers cost money and cardboard is free. Including
    // those here would list visits that can never be collected, permanently overstating the
    // "still to collect" figure — the one number this screen exists to get right.
    const { data: facRows, error: facErr } = await db
      .from("facilities")
      .select("id,name,type,provider,provider_geofence_id")
      .eq("franchise_id", fr.id)
      .eq("type", "recycling")
      .eq("settlement_mode", "revenue")
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
        message: "No revenue-earning recycling facility is set up yet. In Settings → Cost → Facilities, link the facility to its telematics geofence and set 'Money' to \"They pay us\".",
      });
    }

    // ── Visits: completed dwells at those geofences ───────────────────────────────────────
    const fromIso = body.from ? new Date(String(body.from)).toISOString() : null;
    const toIso = body.to ? new Date(String(body.to)).toISOString() : null;

    // Short stops are FETCHED ALWAYS, then filtered below. Two reasons they cannot be excluded in
    // SQL: flap detection needs to see them (a real visit split by a tight boundary shows up as
    // two short stops, and dropping them here would hide both halves), and the caller can ask to
    // see them for payment validation.
    const includeShort = body.includeShort === true;

    const visits = await pageAll((from, to) => {
      let q = db.from("geofence_alerts")
        .select("id,geofence_id,geofence_name,vehicle_number,duration,start_time,end_time,created_at,event_id,action")
        .eq("franchise_id", fr.id)
        .eq("event_type", "geofence_exit")
        .not("duration", "is", null)
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
        .select("id,alert_id,amount,weight_lbs,settled_at,note,resolution")
        .eq("franchise_id", fr.id)
        .range(from, to));
    const settByAlert = new Map<string, any>();
    for (const s of settlements) if (s.alert_id != null) settByAlert.set(String(s.alert_id), s);

    // ── Boundary flap detection ───────────────────────────────────────────────────────────
    // Owner: "a truck goes in/out of a geofence when the border is too tight so you'll see two
    // in/out events for the same truck, on the same day at nearly the same time. The reality is
    // that the first is a valid in, and the second entry is a valid out."
    //
    // So: SAME truck + SAME geofence, with a small gap between one exit and the next entry, is ONE
    // real visit that got split. Neither half's duration is meaningful on its own.
    //
    // This is NOT the same as two trucks at one facility on one day — that is two genuine visits,
    // each potentially owed revenue. Keying on vehicle_number is what separates them, and it is
    // exactly the case that made a 6-minute 5/29 stop worth surfacing rather than hiding.
    // The TRUE duration of a split visit is first-entry → last-exit, which is what owner described:
    // "the first is a valid in, and the second entry is a valid out". Neither half is right, and
    // crucially the halves can BOTH fall under the 8-minute threshold while the real visit is well
    // over it — so a genuine, collectable visit disappears entirely. That is why the span is
    // computed and returned rather than just flagging the rows.
    const FLAP_GAP_SEC = 1800;   // 30 min between one exit and the next entry at the same fence
    // BOTH parts of a split are shown, deliberately — they are not collapsed.
    //
    // Owner reconciles rows against what the vendor actually paid: "If there is only one payment
    // for that day, I can question the vendor, especially if there are two trucks, less so if it
    // is only one truck at nearly the same time. If a false positive, I'll just mark that one as
    // close out." Collapsing would remove the evidence that decision is made from. The badge
    // carries the signal (same truck, minutes apart) and Close out handles the false positive.
    const flapInfo = new Map<string, { spanSec: number; parts: number }>();
    const byTruckFence = new Map<string, any[]>();
    for (const v of visits) {
      const k = String(v.vehicle_number || "") + "|" + String(v.geofence_id);
      let arr = byTruckFence.get(k);
      if (!arr) { arr = []; byTruckFence.set(k, arr); }
      arr.push(v);
    }
    const tsOf = (v: any, which: "start" | "end") =>
      new Date(which === "start" ? (v.start_time || v.created_at) : (v.end_time || v.start_time || v.created_at)).getTime();

    for (const group of byTruckFence.values()) {
      // Ascending by start so "the next visit" is the one that follows in time.
      group.sort((a, b) => tsOf(a, "start") - tsOf(b, "start"));
      let chain: any[] = [];
      const flush = () => {
        if (chain.length > 1) {
          const spanSec = Math.round((tsOf(chain[chain.length - 1], "end") - tsOf(chain[0], "start")) / 1000);
          for (const m of chain) flapInfo.set(String(m.id), { spanSec, parts: chain.length });
        }
        chain = [];
      };
      for (const v of group) {
        if (!chain.length) { chain = [v]; continue; }
        const gap = (tsOf(v, "start") - tsOf(chain[chain.length - 1], "end")) / 1000;
        // Chains, not just pairs — a very tight boundary can split one visit three or more ways.
        if (gap >= 0 && gap <= FLAP_GAP_SEC) chain.push(v);
        else { flush(); chain = [v]; }
      }
      flush();
    }

    const allRows = visits.map((v) => {
      const s = settByAlert.get(String(v.id)) || null;
      const fac = facByGeofence.get(String(v.geofence_id));
      return {
        // Under the drive-through threshold. Hidden by default, but the row still exists so it can
        // be revealed for payment validation rather than silently dropped.
        isShort: Number(v.duration) < MIN_VISIT_SEC,
        // Part of a same-truck chain at one fence seconds apart — one real visit split by a tight
        // boundary. Its own duration is not trustworthy; flapSpanSec is the real first-in→last-out.
        likelyFlap: flapInfo.has(String(v.id)),
        flapSpanSec: flapInfo.get(String(v.id))?.spanSec ?? null,
        flapParts: flapInfo.get(String(v.id))?.parts ?? null,
        alertId: v.id,
        eventId: v.event_id != null ? String(v.event_id) : null,
        geofenceId: String(v.geofence_id),
        facilityName: fac ? fac.name : (v.geofence_name || "(unknown)"),
        geofenceName: v.geofence_name,
        truck: v.vehicle_number,
        startedAt: v.start_time || v.created_at,
        // Motive's own exit timestamp. No created_at fallback: created_at is when the ROW was
        // written (for backfilled rows, the day the import ran), so falling back would print a
        // confidently wrong out-time. Absent is better than wrong — the UI omits it.
        endedAt: v.end_time || null,
        durationSec: v.duration,
        settled: !!s,
        // 'collected' = a real amount came in. 'closed' = cleared with NO known amount, so the
        // stored amount is meaningless and must never be summed as revenue (migration 0064).
        resolution: s ? (s.resolution || "collected") : null,
        amount: s ? Number(s.amount) : null,
        weightLbs: s && s.weight_lbs != null ? Number(s.weight_lbs) : null,
        settledAt: s ? s.settled_at : null,
        note: s ? s.note : null,
      };
    });

    // Short stops drop out unless asked for — EXCEPT one that has already been settled or closed,
    // which must always remain visible. Hiding a row that carries a real recorded amount would
    // make that money vanish from every total with no way to find it again.
    // A settled row is NEVER hidden — hiding a row that carries a recorded amount would make that
    // money vanish from every total with no way to find it again.
    const rows = allRows.filter((r) => includeShort || !r.isShort || r.settled);
    const shortHidden = allRows.filter((r) => r.isShort && !r.settled).length;

    if (action === "listVisits") {
      const status = String(body.status || "all");     // all | outstanding | collected | closed
      const facilityGeofenceId = String(body.geofenceId || "");
      const isClosed = (r: typeof rows[number]) => r.settled && r.resolution === "closed";
      let out = rows;
      // "collected" excludes closed — a visit cleared without an amount is not a collection, and
      // listing it there would put a $0 row next to real money.
      if (status === "outstanding") out = out.filter((r) => !r.settled);
      else if (status === "collected") out = out.filter((r) => r.settled && !isClosed(r));
      else if (status === "closed") out = out.filter(isClosed);
      if (facilityGeofenceId) out = out.filter((r) => r.geofenceId === facilityGeofenceId);
      return json({
        success: true,
        visits: out,
        totals: {
          all: rows.length,
          outstanding: rows.filter((r) => !r.settled).length,
          collected: rows.filter((r) => r.settled && !isClosed(r)).length,
          closed: rows.filter(isClosed).length,
        },
        // How many unsettled short stops are being withheld right now — so the UI can offer to
        // reveal them by count instead of hinting that something might be missing.
        shortHidden,
        includeShort,
      });
    }

    if (action === "summary") {
      // Collected totals per period + what is still to collect. No aging, no overdue — Owner:
      // "timing doesn't matter, I'm not looking for DSO or anything like an aging report."
      // THREE states, not two. A closed visit has left the outstanding list but carries no known
      // amount, so it must not enter any revenue figure — including the visit COUNT, which would
      // otherwise drag $/visit toward zero. It gets its own count so written-off money stays
      // visible instead of reading as $0 collected.
      const collected = rows.filter((r) => r.settled && r.resolution !== "closed");
      const closed = rows.filter((r) => r.settled && r.resolution === "closed");
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
      const byFacility: Record<string, { name: string; amount: number; weight: number; collected: number; closed: number; outstanding: number }> = {};
      for (const r of rows) {
        const b = byFacility[r.facilityName] || (byFacility[r.facilityName] = { name: r.facilityName, amount: 0, weight: 0, collected: 0, closed: 0, outstanding: 0 });
        if (!r.settled) b.outstanding += 1;
        else if (r.resolution === "closed") b.closed += 1;
        else { b.amount += r.amount || 0; b.weight += r.weightLbs || 0; b.collected += 1; }
      }
      return json({
        success: true,
        grain,
        totalCollected: collected.reduce((a, r) => a + (r.amount || 0), 0),
        totalWeightLbs: collected.reduce((a, r) => a + (r.weightLbs || 0), 0),
        collectedVisits: collected.length,
        closedVisits: closed.length,
        outstandingVisits: rows.length - collected.length - closed.length,
        byPeriod: Object.values(byPeriod).sort((a, b) => a.key < b.key ? 1 : -1),
        byFacility: Object.values(byFacility).sort((a, b) => b.amount - a.amount),
        shortHidden,
        includeShort,
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
        // Entering an amount always means collected — including re-entering one on a visit that
        // had been closed, which is the natural "I found the figure after all" correction.
        resolution: "collected",
      };
      const { error } = await db.from("visit_settlements")
        .upsert(row, { onConflict: "franchise_id,alert_id" });
      if (error) {
        console.error("[recycling] saveSettlement failed:", error.message);
        return json({ success: false, error: "could not save" }, 500);
      }
      return json({ success: true, alertId: visit.id, amount, weightLbs: weight });
    }

    // Clear a visit off the outstanding list WITHOUT claiming an amount.
    //
    // Two real cases, both of which will never receive a figure: nothing was collected and nothing
    // is coming, or payment was taken but never written down. Recording either as 0 would be a
    // false statement about revenue — see 0064 for why 0 cannot be overloaded.
    if (action === "closeVisit") {
      const alertId = body.alertId;
      if (alertId == null) return json({ success: false, error: "alertId required" }, 400);
      const visit = visits.find((v) => String(v.id) === String(alertId));
      if (!visit) return json({ success: false, error: "visit not found for this franchise" }, 404);

      const row = {
        franchise_id: fr.id,
        alert_id: visit.id,
        provider: "motive",
        provider_event_id: visit.event_id != null ? String(visit.event_id) : null,
        provider_geofence_id: visit.geofence_id,
        visit_started_at: visit.start_time || visit.created_at,
        // NOT NULL on the column, and meaningless for a closed row — every reporting path filters
        // on resolution before summing, so this 0 never reaches a total.
        amount: 0,
        weight_lbs: null,
        settled_at: new Date().toISOString(),
        settled_by: body.profileId || null,
        note: body.note ? String(body.note) : null,
        resolution: "closed",
      };
      const { error } = await db.from("visit_settlements")
        .upsert(row, { onConflict: "franchise_id,alert_id" });
      if (error) {
        console.error("[recycling] closeVisit failed:", error.message);
        return json({ success: false, error: "could not close" }, 500);
      }
      return json({ success: true, alertId: visit.id, resolution: "closed" });
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
