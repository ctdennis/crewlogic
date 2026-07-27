// Supabase Edge Function: crewlogic-assignments — FW-59 / docs/contract-crewlogic-assignments.md
//
// Authoritative truck<->route assignment per service day, + (later) ETA/late prediction.
//   action 'get'   — roster + current assignments for a franchise+date (feeds the board dropdowns)
//   action 'set'   — replace-set the trucks on one route (the hard set)
//   action 'eta'   — [next slice] day-start feasibility + live prediction
//   action 'check' — [next slice] set-based geofence mismatch / auto-set
//
// AUTH MODEL — matches crewlogic-jobs: the app authenticates most users (Google) with a custom session
// that has no Supabase JWT, so it calls with the anon key and passes franchiseInternalID (= the
// franchises.id UUID). This function uses the SERVICE role and scopes every query by that UUID.
// (SEC follow-up, app-wide: verify the franchise server-side once auth is unified — same open item as
// crewlogic-jobs/-settings/-todays-workorders.)
//
// Deploy: supabase functions deploy <ref> crewlogic-assignments --use-api --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveTimezone, todayPartsInTz } from '../_shared/tz.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SOURCES = new Set(['manual', 'default', 'inferred']);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function str(v: unknown): string { return v == null ? '' : String(v).trim(); }

// Today (YYYY-MM-DD) in the franchise's own timezone, read from cost_settings. Falls back to ET.
async function defaultServiceDate(db: ReturnType<typeof createClient>, franchiseId: string): Promise<string> {
  const { data } = await db.from('franchises').select('cost_settings').eq('id', franchiseId).maybeSingle();
  const cs = (data?.cost_settings as Record<string, unknown>) || {};
  const tz = resolveTimezone(cs);
  const { year, month, day } = todayPartsInTz(tz);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405);

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = str(body.action) || 'get';
  const franchiseInternalID = str(body.franchiseInternalID);
  if (!franchiseInternalID) return json({ success: false, error: 'franchiseInternalID required' }, 400);

  const db = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const serviceDate = str(body.serviceDate) || await defaultServiceDate(db, franchiseInternalID);

    // ── get ────────────────────────────────────────────────────────────────
    // Roster (active trucks) + current assignments for the date. Routes come from the board the
    // client already has loaded; live truck status (the dot) is merged client-side from its GPS poll.
    if (action === 'get') {
      const { data: trucks, error: tErr } = await db.from('franchise_trucks')
        .select('truck_key, name, vin, provider, sort_order, active')
        .eq('franchise_id', franchiseInternalID).eq('active', true)
        .order('sort_order', { ascending: true });
      if (tErr) throw tErr;

      const { data: rows, error: aErr } = await db.from('route_truck_assignments')
        .select('vonigo_route_id, route_name, truck_key, source, assigned_by, updated_at')
        .eq('franchise_id', franchiseInternalID).eq('service_date', serviceDate);
      if (aErr) throw aErr;

      // Group assignment rows by route.
      const byRoute = new Map<string, Record<string, unknown>>();
      for (const r of rows || []) {
        const key = String(r.vonigo_route_id);
        if (!byRoute.has(key)) byRoute.set(key, { vonigoRouteId: key, routeName: r.route_name, trucks: [] });
        (byRoute.get(key)!.trucks as unknown[]).push({
          truckKey: r.truck_key, source: r.source, assignedBy: r.assigned_by, updatedAt: r.updated_at,
        });
      }

      return json({
        success: true,
        serviceDate,
        trucks: (trucks || []).map(t => ({
          truckKey: t.truck_key, name: t.name, number: t.sort_order, provider: t.provider, active: t.active,
        })),
        assignments: Array.from(byRoute.values()),
      });
    }

    // ── set ────────────────────────────────────────────────────────────────
    // Replace-set the trucks on one route for the date. truckKeys=[] clears the route.
    if (action === 'set') {
      const vonigoRouteId = str(body.vonigoRouteId);
      const routeName = str(body.routeName);
      const assignedBy = str(body.assignedBy) || null;
      if (!vonigoRouteId) return json({ success: false, error: 'vonigoRouteId required' }, 400);

      const raw = Array.isArray(body.truckKeys) ? body.truckKeys : [];
      const truckKeys = Array.from(new Set(raw.map(str).filter(Boolean))); // dedupe + drop blanks

      // Replace-set: clear this route's rows for the day, then insert the new set.
      const { error: dErr } = await db.from('route_truck_assignments')
        .delete()
        .eq('franchise_id', franchiseInternalID)
        .eq('service_date', serviceDate)
        .eq('vonigo_route_id', vonigoRouteId);
      if (dErr) throw dErr;

      let inserted: unknown[] = [];
      if (truckKeys.length) {
        const rows = truckKeys.map(tk => ({
          franchise_id: franchiseInternalID,
          service_date: serviceDate,
          vonigo_route_id: vonigoRouteId,
          route_name: routeName || null,
          truck_key: tk,
          source: 'manual',
          assigned_by: assignedBy,
        }));
        const { data: ins, error: iErr } = await db.from('route_truck_assignments')
          .insert(rows)
          .select('vonigo_route_id, truck_key, source, updated_at');
        if (iErr) throw iErr;
        inserted = ins || [];
      }

      return json({
        success: true, serviceDate, vonigoRouteId,
        assignments: (inserted as Record<string, unknown>[]).map(r => ({
          vonigoRouteId: r.vonigo_route_id, truckKey: r.truck_key, source: r.source, updatedAt: r.updated_at,
        })),
      });
    }

    // eta / check land in the next slice.
    if (action === 'eta' || action === 'check') {
      return json({ success: false, error: 'not_implemented_yet', action }, 501);
    }

    return json({ success: false, error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error('[crewlogic-assignments] error', action, franchiseInternalID, e);
    return json({ success: false, error: 'assignments_failed' }, 500);
  }
});
