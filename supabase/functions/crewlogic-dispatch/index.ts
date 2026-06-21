// Supabase Edge Function: crewlogic-dispatch (v0.1 — deterministic tool layer for "Manage Jobs")
//
// Reusable server-side tools for the voice dispatcher (and the future Real Route Optimizer).
// NO AI yet — this is the plumbing the Claude tool-agent (next increment) will call. Each action
// is a discrete, independently-callable tool. All Vonigo creds stay server-side (resolved per
// franchise via get_vonigo_credential). All proven against #90 during the 2026-06 recon/spikes.
//
// Actions (body.action):
//   ping                                            → { ok }
//   listRouteJobs { franchiseID, dayID, route? }    → jobs[] (geocoded lat/lon + duration) — route-opt reuses this
//   resolveJob    { franchiseID, dayID, route, position?|timeMin?|jobID? } → one job (or ambiguity list)
//   suggestSlots  { franchiseID, dayID, durationMin, zip?, routeID?, serviceTypeID? } → open slots (zoned + override)
//   moveJob       { franchiseID, woID, dayID, routeID, startTime, durationMin, zip, serviceTypeID?, dryRun? }
//   cancelJob     { franchiseID, jobID, categoryOptionID, reasonOptionID, comments?, dryRun? }
//
// Move = lock (availability method 2 → Ids.lockID) + WorkOrders method 16. Cancel = Jobs method 4
// (fields 974 category / 975 reason / 973 comments). Field-edit of appt fields is a no-op (see memory).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const TENANT_ID = '946a4535-aa61-45b6-a6fb-9190ff546d41';
const VONIGO_BASE = 'https://junkluggers.vonigo.com/api/v1';
// WorkOrder fieldIDs
const F = { status: 181, client: 183, address: 184, date: 185, duration: 186, time: 9082, price: 813 };

const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const supa = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// dayID "YYYYMMDD" → naive-Eastern midnight epoch (Vonigo convention for WorkOrder date fields).
function dayEpoch(dayID: string): number {
  const y = +dayID.slice(0, 4), mo = +dayID.slice(4, 6) - 1, d = +dayID.slice(6, 8);
  return Math.floor(Date.UTC(y, mo, d, 0, 0, 0) / 1000);
}
function timeLabel(min: number): string {
  if (!Number.isFinite(min)) return '';
  const h = Math.floor(min / 60) % 24, m = min % 60, ap = h < 12 ? 'AM' : 'PM', h12 = (h % 12) === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}
function zipOf(address: string): string { const m = String(address || '').match(/\b(\d{5})\b/); return m ? m[1] : ''; }
function shortRoute(name: string): string { const m = String(name || '').match(/\(([^)]+)\)/); return m ? m[1] : String(name || '').trim(); }

async function vonigoAuth(franchiseID: string): Promise<{ token: string } | { error: string }> {
  const sb = supa();
  const { data: fr } = await sb.from('franchises').select('id').eq('external_id', franchiseID).eq('tenant_id', TENANT_ID).single();
  if (!fr) return { error: 'franchise not found: ' + franchiseID };
  let creds: any = null;
  const { data: cr } = await sb.rpc('get_vonigo_credential', { franchise_id_param: fr.id });
  if (cr && cr.length) creds = cr[0];
  if (!creds) { for (const p of ['p_franchise_id', 'franchise_id', 'franchiseid', 'fid']) { const a: Record<string, string> = {}; a[p] = fr.id; const r = await sb.rpc('get_vonigo_credential', a); if (!r.error && r.data && r.data.length) { creds = r.data[0]; break; } } }
  if (!creds) { const { data: d } = await sb.from('vonigo_credentials').select('vonigo_username, vonigo_md5').eq('franchise_id', fr.id).limit(1); if (d && d.length) creds = d[0]; }
  if (!creds) return { error: 'no Vonigo credentials for franchise ' + franchiseID };
  const u = new URL(VONIGO_BASE + '/security/login/');
  u.searchParams.set('company', 'Vonigo'); u.searchParams.set('userName', creds.vonigo_username); u.searchParams.set('password', creds.vonigo_md5);
  const a = await (await fetch(u.toString())).json();
  if (a.errNo !== 0 || !a.securityToken) return { error: 'Vonigo auth failed: ' + (a.errMsg || 'no token') };
  return { token: a.securityToken };
}
const vpost = (token: string, path: string, payload: any) =>
  fetch(VONIGO_BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ securityToken: token, ...payload }) }).then(r => r.json());

// Geocode (cache-first, free US Census) — gives route-opt the lat/lon it needs.
async function geocode(addr: string): Promise<{ lat: number; lon: number } | null> {
  const oneLine = String(addr || '').replace(/\n/g, ', ').replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  const key = oneLine.toLowerCase(); const sb = supa();
  const { data: c } = await sb.from('geocode_cache').select('lat, lon, found').eq('address_key', key).maybeSingle();
  if (c) return c.found ? { lat: c.lat, lon: c.lon } : null;
  try {
    const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=' + encodeURIComponent(oneLine) + '&benchmark=Public_AR_Current&format=json';
    const d = await (await fetch(url)).json();
    const m = d?.result?.addressMatches?.[0];
    const g = m?.coordinates ? { lat: Number(m.coordinates.y), lon: Number(m.coordinates.x) } : null;
    await sb.from('geocode_cache').upsert({ address_key: key, lat: g?.lat ?? null, lon: g?.lon ?? null, found: !!g, provider: 'census', updated_at: new Date().toISOString() });
    return g;
  } catch { return null; }
}

// listRouteJobs: WorkOrders for a day (+optional route filter), enriched + geocoded.
async function listRouteJobs(token: string, franchiseID: string, dayID: string, route?: string, withCoords = true) {
  const ds = dayEpoch(dayID), de = ds + 86400;
  const r = await vpost(token, '/data/WorkOrders/', { franchiseID, pageNo: '1', pageSize: '200', isCompleteObject: 'true', dateMode: '3', dateStart: String(ds), dateEnd: String(de) });
  const gf = (f: any[], id: number) => (f.find((x: any) => x.fieldID === id) || {});
  let jobs = (r.WorkOrders || []).map((w: any) => {
    const f = w.Fields || [], rel = w.Relations || [];
    const jobRel = rel.find((x: any) => x.relationType === 'job'); const routeRel = rel.find((x: any) => x.relationType === 'route');
    const addr = gf(f, F.address).fieldValue || '';
    const timeMin = parseInt(gf(f, F.time).fieldValue || '0', 10);
    return { jobID: jobRel ? String(jobRel.objectID) : null, woID: String(w.objectID), route: routeRel ? routeRel.name : '', routeCode: shortRoute(routeRel ? routeRel.name : ''), routeID: routeRel ? String(routeRel.objectID) : null, timeMin, timeLabel: timeLabel(timeMin), durationMin: parseInt(gf(f, F.duration).fieldValue || '0', 10), client: gf(f, F.client).fieldValue || '', address: addr, zip: zipOf(addr), status: gf(f, F.status).fieldValue || '', statusOptionID: gf(f, F.status).optionID || 0, lat: null as number | null, lon: null as number | null };
  }).filter((j: any) => j.jobID && j.statusOptionID !== 162 && !/URGENTCB/i.test(j.route));
  if (route) { const rc = route.toUpperCase(); jobs = jobs.filter((j: any) => j.routeCode.toUpperCase() === rc || j.route.toUpperCase().includes(rc)); }
  jobs.sort((a: any, b: any) => a.timeMin - b.timeMin);
  if (withCoords) await Promise.all(jobs.map(async (j: any) => { if (j.address) { const g = await geocode(j.address); if (g) { j.lat = g.lat; j.lon = g.lon; } } }));
  return jobs;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'POST only' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');
    if (action === 'ping') return json({ success: true, ok: true, version: '0.1' });

    const franchiseID = String(body.franchiseID || '');
    if (!franchiseID) return json({ success: false, error: 'franchiseID required' }, 400);
    const auth = await vonigoAuth(franchiseID);
    if ('error' in auth) return json({ success: false, error: auth.error }, 502);
    const token = auth.token;

    if (action === 'listRouteJobs') {
      const jobs = await listRouteJobs(token, franchiseID, String(body.dayID), body.route ? String(body.route) : undefined, body.withCoords !== false);
      return json({ success: true, dayID: body.dayID, count: jobs.length, jobs });
    }

    if (action === 'resolveJob') {
      const dayID = String(body.dayID);
      const jobs = await listRouteJobs(token, franchiseID, dayID, body.route ? String(body.route) : undefined, false);
      let matches = jobs;
      if (body.jobID) matches = jobs.filter((j: any) => j.jobID === String(body.jobID));
      else if (Number.isFinite(body.timeMin)) matches = jobs.filter((j: any) => j.timeMin === Number(body.timeMin));
      else if (Number.isFinite(body.position)) { const p = Number(body.position); matches = jobs[p - 1] ? [jobs[p - 1]] : []; } // 1-based stop # within the route filter
      if (matches.length === 1) return json({ success: true, resolved: matches[0] });
      return json({ success: true, resolved: null, ambiguous: matches.length > 1, candidates: matches, note: matches.length === 0 ? 'no match' : 'multiple matches — ask to disambiguate' });
    }

    if (action === 'suggestSlots') {
      const dayID = String(body.dayID); const ds = dayEpoch(dayID), de = ds + 79200;
      const duration = String(body.durationMin || 120), serviceTypeID = String(body.serviceTypeID || '11');
      const p: any = { method: '0', dateStart: String(ds), dateEnd: String(de), duration, locationID: '1', serviceTypeID, pageNo: '1', pageSize: '400' };
      if (body.zip) p.zip = String(body.zip);
      if (body.routeID) p.routeID = String(body.routeID);
      const a = await vpost(token, '/resources/availability/', p);
      const slots = (a.Availability || []).filter((s: any) => String(s.dayID) === dayID).map((s: any) => ({ routeID: String(s.routeID), startTime: parseInt(s.startTime, 10), label: timeLabel(parseInt(s.startTime, 10)) }));
      return json({ success: true, dayID, zoned: !!body.zip, count: slots.length, slots });
    }

    if (action === 'moveJob') {
      const { woID, dayID, routeID, startTime } = body;
      const duration = String(body.durationMin || 90), zip = String(body.zip || ''), serviceTypeID = String(body.serviceTypeID || '11');
      if (!woID || !dayID || !routeID || startTime == null) return json({ success: false, error: 'moveJob needs woID, dayID, routeID, startTime' }, 400);
      const plan = { woID: String(woID), dayID: String(dayID), routeID: String(routeID), startTime: Number(startTime), startLabel: timeLabel(Number(startTime)), duration, zip };
      if (body.dryRun) return json({ success: true, dryRun: true, plan });
      const lock = await vpost(token, '/resources/availability/', { method: '2', dayID: String(dayID), routeID: String(routeID), zip, serviceTypeID, duration, startTime: String(startTime) });
      const lockID = lock.Ids && (lock.Ids.lockID || lock.Ids.LockID);
      if (!lockID) return json({ success: false, error: 'could not lock target slot (not open?)', lock: { errNo: lock.errNo, errors: lock.Errors || null } }, 409);
      const mv = await vpost(token, '/data/WorkOrders/', { method: '16', objectID: String(woID), lockID: String(lockID) });
      const ok = mv.errNo === 0;
      console.log(`[dispatch][AUDIT] moveJob wo=${woID} -> route=${routeID} ${plan.startLabel} ${dayID} lock=${lockID} errNo=${mv.errNo}`);
      return json({ success: ok, plan, lockID, move: { errNo: mv.errNo, errMsg: mv.errMsg || null, errors: mv.Errors || null } }, ok ? 200 : 502);
    }

    if (action === 'cancelJob') {
      const { jobID, categoryOptionID, reasonOptionID } = body;
      const comments = String(body.comments || '');
      if (!jobID || !categoryOptionID || !reasonOptionID) return json({ success: false, error: 'cancelJob needs jobID, categoryOptionID, reasonOptionID' }, 400);
      const plan = { jobID: String(jobID), categoryOptionID: String(categoryOptionID), reasonOptionID: String(reasonOptionID), comments };
      if (body.dryRun) return json({ success: true, dryRun: true, plan });
      const Fields = [{ fieldID: 974, optionID: String(categoryOptionID) }, { fieldID: 975, optionID: String(reasonOptionID) }];
      if (comments) Fields.push({ fieldID: 973, fieldValue: comments } as any);
      const c = await vpost(token, '/data/Jobs/', { method: '4', objectID: String(jobID), Fields });
      const ok = c.errNo === 0;
      console.log(`[dispatch][AUDIT] cancelJob job=${jobID} cat=${categoryOptionID} reason=${reasonOptionID} errNo=${c.errNo}`);
      return json({ success: ok, plan, cancel: { errNo: c.errNo, errMsg: c.errMsg || null, errors: c.Errors || null } }, ok ? 200 : 502);
    }

    return json({ success: false, error: 'unknown action: ' + action }, 400);
  } catch (e) {
    const err = e as Error;
    console.error('[dispatch] error:', err?.stack || err?.message || String(e));
    return json({ success: false, error: err.message || String(e) }, 500);
  }
});
