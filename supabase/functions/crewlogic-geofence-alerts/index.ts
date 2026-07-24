// Supabase Edge Function: crewlogic-geofence-alerts (read-only)
//
// Service-role reads of geofence_alerts (+ job_geofences) scoped by the caller-supplied
// franchiseInternalID, so the Live Alerts rail and the two geofence reports DON'T depend on the caller's
// Supabase JWT. Google logins drop that token on expiry/hard-refresh, which made the direct PostgREST +
// RLS reads (policy: `to authenticated`, `franchise_id = current_franchise_id()`) return EMPTY even though
// the data was intact (2026-07-24 incident: rail + both reports blanked, 4k+ rows present). Same auth model
// as crewlogic-jobs / crewlogic-settings: SERVICE role + client-resolved franchiseInternalID.
//
// (SEC follow-up, app-wide: verify the franchise server-side once the auth model is unified — same open
// item noted on crewlogic-jobs/-settings/-todays-workorders, which trust the client franchiseID today.)
//
// Actions (POST { action, franchiseInternalID, ... }):
//   'recent'     -> { success, rows }             rail: newest-first 50 (same columns the rail selected)
//   'facilities' -> { success, rows }             report/facilities: geofence_exit + duration not null (ALL, paged)
//   'customers'  -> { success, alerts, jobGeofences }  report/customers: job_arrive|job_leave since sinceIso
//                                                  (paged) + the job_geofences wo_id->route map (paged)
//
// Deploy: supabase functions deploy <ref> crewlogic-geofence-alerts --use-api --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function str(v: unknown): string { return v == null ? '' : String(v).trim(); }

// deno-lint-ignore no-explicit-any
type Q = any;
// Page a franchise-scoped SELECT past PostgREST's 1000-row cap (mirrors the client's _pagedFetch, which the
// facilities "All time" + customers ranges can exceed — a truncated read would silently drop rows).
async function pageAll(makeQuery: () => Q): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  let from = 0;
  const out: Record<string, unknown>[] = [];
  for (;;) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data || []) as Record<string, unknown>[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405);

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = str(body.action) || 'recent';
  const fid = str(body.franchiseInternalID);
  if (!fid) return json({ success: false, error: 'franchiseInternalID required' }, 400);

  const db = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    if (action === 'recent') {
      // Rail: newest-first 50. Same column set the rail selected.
      const { data, error } = await db.from('geofence_alerts')
        .select('id, franchise_id, action, event_type, vehicle_number, geofence_id, geofence_name, category, start_time, created_at')
        .eq('franchise_id', fid)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return json({ success: true, rows: data || [] });
    }

    if (action === 'facilities') {
      // Report / facilities: completed facility visits (exit events with a dwell duration), newest-first, ALL.
      const rows = await pageAll(() => db.from('geofence_alerts')
        .select('geofence_name, category, duration, created_at')
        .eq('franchise_id', fid)
        .eq('event_type', 'geofence_exit')
        .not('duration', 'is', null)
        .order('created_at', { ascending: false }));
      return json({ success: true, rows });
    }

    if (action === 'customers') {
      // Report / customers: job arrive/leave events since sinceIso (paged) + the job_geofences route map.
      const sinceIso = str(body.sinceIso);
      if (!sinceIso) return json({ success: false, error: 'sinceIso required for customers' }, 400);
      const [alerts, jobGeofences] = await Promise.all([
        pageAll(() => db.from('geofence_alerts')
          .select('wo_id, job_id, geofence_name, vehicle_number, event_type, duration, start_time, created_at')
          .eq('franchise_id', fid)
          .not('wo_id', 'is', null)
          .in('event_type', ['job_arrive', 'job_leave'])
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: true })),
        pageAll(() => db.from('job_geofences')
          .select('wo_id, route')
          .eq('franchise_id', fid)
          .not('route', 'is', null)
          .order('wo_id', { ascending: true })),
      ]);
      return json({ success: true, alerts, jobGeofences });
    }

    if (action === 'crew-infer') {
      // Infer likely crew per truck from GPS dwells + Vonigo job crew (docs/plan-truck-crew-inference.md).
      // Truck (vehicle_number) -> jobs it ARRIVED at today (job_arrive) -> each job's assigned crew
      // (job_source_snapshot.crew_display) -> aggregate. Flags tip-split mismatches (truck's crew dwelled at a
      // job they're NOT assigned to) + no-crew jobs. sinceIso = franchise-local start-of-today (client-supplied).
      const sinceIso = str(body.sinceIso);
      if (!sinceIso) return json({ success: false, error: 'sinceIso required for crew-infer' }, 400);

      const arrivals = await pageAll(() => db.from('geofence_alerts')
        .select('vehicle_number, wo_id')
        .eq('franchise_id', fid)
        .eq('event_type', 'job_arrive')
        .not('wo_id', 'is', null)
        .gte('created_at', sinceIso));
      if (!arrivals.length) return json({ success: true, trucks: [] });

      // Crew + route + client for each visited job (via the mirror).
      const woIds = [...new Set(arrivals.map((a) => String(a.wo_id)))];
      const apptRows = await pageAll(() => db.from('job_appointments')
        .select('source_external_id, snap:job_source_snapshot(crew_display, customer_display, route_name)')
        .eq('franchise_id', fid)
        .in('source_external_id', woIds));
      const jobInfo = new Map<string, { crew: string[]; route: string; client: string }>();
      for (const r of apptRows) {
        // deno-lint-ignore no-explicit-any
        const snap: any = Array.isArray((r as any).snap) ? (r as any).snap[0] : (r as any).snap;
        const crew = (snap && Array.isArray(snap.crew_display) ? snap.crew_display : [])
          .map((c: { name?: string }) => str(c?.name)).filter(Boolean);
        const client = str(snap && snap.customer_display && snap.customer_display.name);
        const route = str(snap && snap.route_name);
        jobInfo.set(String((r as { source_external_id: unknown }).source_external_id), { crew, route, client });
      }

      // Group by truck -> visited jobs.
      const byTruck = new Map<string, Set<string>>();
      for (const a of arrivals) {
        const v = str(a.vehicle_number); if (!v) continue;
        if (!byTruck.has(v)) byTruck.set(v, new Set());
        byTruck.get(v)!.add(String(a.wo_id));
      }

      const THRESH = 0.6;
      interface TruckOut { vehicle_number: string; crew: string[]; candidates: string[]; confidence: string; routes: string[]; jobCount: number; jobsWithCrew: number; mismatches: { client: string; missing: string[] }[]; noCrew: string[] }
      const trucks: TruckOut[] = [];
      for (const [vehicle, woSet] of byTruck) {
        const jobs = [...woSet].map((w) => jobInfo.get(w)).filter(Boolean) as { crew: string[]; route: string; client: string }[];
        const withCrew = jobs.filter((j) => j.crew.length);
        const tally = new Map<string, number>();
        for (const j of withCrew) for (const name of new Set(j.crew)) tally.set(name, (tally.get(name) || 0) + 1);
        const need = Math.max(1, Math.ceil(THRESH * withCrew.length));
        const crew = [...tally.entries()].filter(([, n]) => n >= need).map(([name]) => name).sort();
        const candidates = [...tally.keys()].sort();
        const routes = [...new Set(jobs.map((j) => j.route).filter(Boolean))].sort();
        const noCrew = jobs.filter((j) => !j.crew.length).map((j) => j.client).filter(Boolean);
        const mismatches = withCrew
          .map((j) => ({ client: j.client, missing: crew.filter((n) => !j.crew.includes(n)) }))
          .filter((m) => m.missing.length);
        trucks.push({ vehicle_number: vehicle, crew, candidates, confidence: 'pending', routes, jobCount: jobs.length, jobsWithCrew: withCrew.length, mismatches, noCrew });
      }

      // Cross-truck overlap downgrades confidence (same person inferred onto 2+ trucks = can't attribute).
      const crewTruckCount = new Map<string, number>();
      for (const t of trucks) for (const n of t.crew) crewTruckCount.set(n, (crewTruckCount.get(n) || 0) + 1);
      for (const t of trucks) {
        const overlap = t.crew.some((n) => (crewTruckCount.get(n) || 0) > 1);
        if (!t.jobsWithCrew) t.confidence = 'unknown';
        else if (t.routes.length === 1 && t.jobsWithCrew >= 2 && t.crew.length && !overlap) t.confidence = 'high';
        else t.confidence = 'low';
      }

      return json({ success: true, trucks });
    }

    return json({ success: false, error: 'unknown action' }, 400);
  } catch (e) {
    console.error('[crewlogic-geofence-alerts] error:', (e as Error).message);
    return json({ success: false, error: 'read_failed' }, 500);
  }
});
