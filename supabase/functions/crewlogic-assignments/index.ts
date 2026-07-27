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

const GOOGLE_KEY = Deno.env.get('GOOGLE_GEOCODING_API_KEY') || Deno.env.get('GOOGLE_MAPS_API_KEY') || '';

// Local minutes-from-midnight → "H:MM AM/PM".
function minsToClock(min: number): string {
  const r = Math.round(min);
  let h = Math.floor(r / 60) % 24; if (h < 0) h += 24;
  const m = ((r % 60) + 60) % 60;
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}

// Best-effort town from a Vonigo address blob ("STREET \n CITY, STATE ZIP"). Returns '' if unparseable.
function parseTown(addr: string): string {
  if (!addr) return '';
  const lines = addr.split('\n').map(s => s.trim()).filter(Boolean);
  const cityLine = lines.length > 1 ? lines[lines.length - 1] : lines[0];
  const town = (cityLine.split(',')[0] || '').trim();
  if (!town || /^\d/.test(town)) return '';                 // still looks like a street number → give up
  return town.replace(/\b[a-z]+/gi, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

// Address → {lat,lon}, cache-first (geocode_cache), Census then Google. Mirrors crewlogic-dispatch geocode().
async function geocodeCached(db: ReturnType<typeof createClient>, addr: string): Promise<{ lat: number; lon: number } | null> {
  const key = addr.replace(/\n/g, ', ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!key) return null;
  const { data: cached } = await db.from('geocode_cache').select('lat, lon, found, provider').eq('address_key', key).maybeSingle();
  if (cached) {
    if (cached.found) return { lat: cached.lat as number, lon: cached.lon as number };
    if (cached.provider === 'google') return null;
  }
  let lat: number | null = null, lon: number | null = null, provider = 'census';
  try {
    const u = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(addr)}&benchmark=Public_AR_Current&format=json`;
    const j = await (await fetch(u)).json();
    const m = j?.result?.addressMatches?.[0]?.coordinates;
    if (m) { lat = m.y; lon = m.x; }
  } catch (_) { /* fall through to Google */ }
  if (lat == null && GOOGLE_KEY) {
    try {
      const u = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${GOOGLE_KEY}`;
      const j = await (await fetch(u)).json();
      const loc = j?.results?.[0]?.geometry?.location;
      if (loc) { lat = loc.lat; lon = loc.lng; provider = 'google'; }
    } catch (_) { /* leave null */ }
  }
  const found = lat != null && lon != null;
  await db.from('geocode_cache').upsert({ address_key: key, lat, lon, found, provider, updated_at: new Date().toISOString() });
  return found ? { lat: lat!, lon: lon! } : null;
}

// Google Distance Matrix → minutes[origins][destinations] (free-flow; day-start is a future/planning walk).
async function driveMinutes(origins: string[], destinations: string[]): Promise<(number | null)[][]> {
  if (!GOOGLE_KEY || !origins.length || !destinations.length) return origins.map(() => destinations.map(() => null));
  const u = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origins.join('|'))}&destinations=${encodeURIComponent(destinations.join('|'))}&units=imperial&key=${GOOGLE_KEY}`;
  const j = await (await fetch(u)).json();
  const rows = j?.rows || [];
  return origins.map((_, i) => destinations.map((__, k) => {
    const el = rows[i]?.elements?.[k];
    return el?.status === 'OK' ? el.duration.value / 60 : null;
  }));
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

    // ── eta (day-start feasibility) ─────────────────────────────────────────
    // Truck-agnostic walk of each route from the yard, in local minutes-from-midnight, checking each
    // job's arrival against its scheduled window [start, start+duration]. The duration dial scales the
    // per-stop SERVICE time used to advance the cursor (not the window). Flagged a guesstimate.
    if (action === 'eta') {
      const mode = str(body.mode) || 'auto';
      if (mode === 'live') return json({ success: false, error: 'live_mode_not_implemented_yet' }, 501);
      let mult = Number(body.durationMultiplier);
      if (!isFinite(mult) || mult <= 0) mult = 1.0;
      mult = Math.max(0.5, Math.min(1.5, mult)); // 60–140% dial (clamped)

      // Yard origin: geocode cost_settings.officeAddress (cache-first).
      const { data: fr } = await db.from('franchises').select('cost_settings').eq('id', franchiseInternalID).maybeSingle();
      const cs = (fr?.cost_settings as Record<string, unknown>) || {};
      const yardAddr = [cs.officeAddress, cs.officeCity, cs.officeState, cs.officeZip].map(v => str(v)).filter(Boolean).join(', ');
      const yard = yardAddr ? await geocodeCached(db, yardAddr) : null;

      // Status tiers: ontime = arrives at/before the scheduled START (green); window = within the window but
      // after the start (yellow); late = after the window closes (red). Rollup = the worst stop on the route.
      const RANK: Record<string, number> = { late: 3, window: 2, unknown: 1, ontime: 0 };

      // Trucks by route CODE (assignments store route_name like "Route 1 (MA1REG)"; the board keys on the code).
      const { data: aRows } = await db.from('route_truck_assignments')
        .select('route_name, truck_key').eq('franchise_id', franchiseInternalID).eq('service_date', serviceDate);
      const trucksByCode = new Map<string, string[]>();
      for (const r of aRows || []) {
        const rn = str(r.route_name); const code = (rn.match(/\(([^)]+)\)/) || [])[1] || rn;
        if (!trucksByCode.has(code)) trucksByCode.set(code, []);
        trucksByCode.get(code)!.push(r.truck_key as string);
      }

      // Route list: PREFER the client's live board jobs (body.routes) so the pills match exactly what's on the
      // board and cover every route; fall back to the mirror only for a standalone preview with no board loaded.
      type NJob = { startMin: number; durationMin: number; lat?: number | null; lon?: number | null; address?: string; jobNo?: string; customerName?: string; phone?: string; town?: string };
      const provided = Array.isArray(body.routes) ? body.routes as Record<string, unknown>[] : null;
      let routeList: { routeCode: string; routeName: string; jobs: NJob[] }[] = [];
      if (provided) {
        routeList = provided.map(r => ({
          routeCode: str(r.routeCode) || str(r.routeName),
          routeName: str(r.routeName) || str(r.routeCode),
          jobs: (Array.isArray(r.jobs) ? r.jobs as Record<string, unknown>[] : []).map(j => ({
            startMin: Number(j.startMin), durationMin: Number(j.durationMin) || 0,
            address: str(j.address), jobNo: str(j.jobNo), customerName: str(j.customerName), phone: str(j.phone), town: str(j.town),
          })).filter(j => isFinite(j.startMin)),
        }));
      } else {
        const { data: appts } = await db.from('job_appointments')
          .select('id, start_minutes, duration_minutes, job:jobs!inner ( service_address, service_city, service_state, service_zip, service_lat, service_lng, job_number ), snapshot:job_source_snapshot ( route_name, customer_display )')
          .eq('franchise_id', franchiseInternalID).eq('scheduled_date', serviceDate);
        const rm = new Map<string, NJob[]>();
        for (const a of (appts as Record<string, unknown>[]) || []) {
          if (a.start_minutes == null) continue;
          const snap = (Array.isArray(a.snapshot) ? a.snapshot[0] : a.snapshot) as Record<string, unknown> | null;
          const jobj = (Array.isArray(a.job) ? a.job[0] : a.job) as Record<string, unknown>;
          const rn = str(snap?.route_name) || 'Unrouted';
          const cd = snap?.customer_display && typeof snap.customer_display === 'object' ? snap.customer_display as Record<string, unknown> : null;
          if (!rm.has(rn)) rm.set(rn, []);
          rm.get(rn)!.push({
            startMin: a.start_minutes as number, durationMin: (a.duration_minutes as number) || 0,
            lat: jobj?.service_lat as number, lon: jobj?.service_lng as number,
            address: [jobj?.service_address, jobj?.service_city, jobj?.service_state, jobj?.service_zip].map(v => str(v)).filter(Boolean).join(', '),
            jobNo: str(jobj?.job_number), customerName: cd ? str(cd.name) : '', phone: cd ? str(cd.phone) : '',
            town: str(jobj?.service_city) || parseTown(str(jobj?.service_address)),
          });
        }
        routeList = Array.from(rm.entries()).map(([rn, jobs]) => ({ routeCode: (rn.match(/\(([^)]+)\)/) || [])[1] || rn, routeName: rn, jobs }));
      }

      const routes: Record<string, unknown>[] = [];
      for (const rt of routeList) {
        const jobs = rt.jobs.slice().sort((a, b) => a.startMin - b.startMin);
        if (!jobs.length) continue;

        // Resolve a "lat,lon" token per job (provided coords, else geocode the address, cache-first).
        const pts: (string | null)[] = [];
        for (const j of jobs) {
          let lat = j.lat, lon = j.lon;
          if ((lat == null || lon == null) && j.address) { const g = await geocodeCached(db, j.address); if (g) { lat = g.lat; lon = g.lon; } }
          pts.push(lat != null && lon != null ? `${lat},${lon}` : null);
        }

        // Sequential legs: yard→job1, job1→job2, … via one Distance Matrix call (diagonal).
        const yardTok = yard ? `${yard.lat},${yard.lon}` : null;
        const seq = [yardTok, ...pts];
        const dm = await driveMinutes(seq.slice(0, -1).map(p => p || '0,0'), seq.slice(1).map(p => p || '0,0'));
        const legs: (number | null)[] = seq.slice(0, -1).map((_, i) => (seq[i] && seq[i + 1]) ? dm[i][i] : null);

        // Walk in local minutes; job 1 assumed on-time at its window start (yard→job1 leg → departYard).
        const outJobs: Record<string, unknown>[] = [];
        let cursor = jobs[0].startMin;
        for (let i = 0; i < jobs.length; i++) {
          const j = jobs[i];
          const winStart = j.startMin, dur = j.durationMin || 0, winEnd = winStart + dur;
          let arrival: number | null, status: string, mel = 0;
          if (i === 0) { arrival = winStart; status = 'ontime'; } // job 1 assumed at its window start
          else {
            const leg = legs[i];
            arrival = leg == null ? null : cursor + leg;
            if (arrival == null) status = 'unknown';
            else if (arrival > winEnd) { status = 'late'; mel = Math.round(arrival - winEnd); }        // past the window close
            else if (arrival <= winStart) { status = 'ontime'; mel = Math.round(winStart - arrival); } // at/before the start
            else { status = 'window'; mel = Math.round(arrival - winStart); }                          // within window, after start
          }
          outJobs.push({
            jobNo: j.jobNo || '', customerName: j.customerName || '', phone: j.phone || '', town: j.town || '',
            windowStart: minsToClock(winStart), windowEnd: minsToClock(winEnd),
            predictedEta: arrival == null ? null : minsToClock(arrival),
            status, minutesEarlyLate: mel,
          });
          const base = i === 0 ? winStart : (arrival == null ? cursor : Math.max(arrival, winStart));
          cursor = base + dur * mult;
        }

        const worst = outJobs.reduce((w, o) => (RANK[o.status as string] || 0) > (RANK[w.status as string] || 0) ? o : w, outJobs[0]);
        routes.push({
          routeName: rt.routeName, routeCode: rt.routeCode,
          trucks: (trucksByCode.get(rt.routeCode) || []).map(tk => ({ truckKey: tk })),
          rollup: { status: worst.status, minutes: worst.minutesEarlyLate },
          departYard: legs[0] != null ? minsToClock(jobs[0].startMin - legs[0]!) : null,
          guesstimate: true, jobs: outJobs,
        });
      }

      return json({ success: true, serviceDate, mode: 'daystart', durationMultiplier: mult, source: provided ? 'board' : 'mirror', yardResolved: !!yard, routes });
    }

    // check lands in the next slice.
    if (action === 'check') return json({ success: false, error: 'not_implemented_yet', action }, 501);

    return json({ success: false, error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error('[crewlogic-assignments] error', action, franchiseInternalID, e);
    return json({ success: false, error: 'assignments_failed' }, 500);
  }
});
