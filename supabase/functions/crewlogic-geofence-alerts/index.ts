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

    return json({ success: false, error: 'unknown action' }, 400);
  } catch (e) {
    console.error('[crewlogic-geofence-alerts] error:', (e as Error).message);
    return json({ success: false, error: 'read_failed' }, 500);
  }
});
