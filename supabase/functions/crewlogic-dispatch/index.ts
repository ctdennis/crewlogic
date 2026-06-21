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
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const MODEL = 'claude-sonnet-4-6';

// Cancel reason picklist (Job field 974 category / 975 reason). optionIDs HARVESTED 2026-06-21 from
// 140 already-cancelled #90 jobs (read /data/Jobs/ objectID+isCompleteObject → Job[0].Fields 974/975).
// Vonigo treats 974/975 as INDEPENDENT dropdowns (historical data pairs the same reason under several
// categories), so any valid category+reason optionID pairing is accepted by method 4. We send the
// screenshot-correct pairing below. All 10 screenshot reasons now captured (the last gap, Pricing →
// 'Customer thought we were free' = 26318, harvested 2026-06-21 from test job 855649). NOT prices —
// stable enums. (execute returns which optionID to fill if any future reason is still null.)
const REASON_CODES: Record<string, { categoryOptionID: number | null; reasons: Record<string, number | null> }> = {
  'customer initiated': { categoryOptionID: 10131, reasons: { 'customer decided to keep the items': 11335, 'customer removed items themselves': 26317, 'duplicate booking': 26319, 'no contact with customer': 21343, 'service no longer required': 10125 } },
  'pricing': { categoryOptionID: 10132, reasons: { 'customer thought we were free': 26318, 'price concerns': 10126, 'used alternative company': 26320 } },
  'scheduling': { categoryOptionID: 10133, reasons: { 'customer not ready': 10129, 'date no longer works for customer': 10127 } },
  // Admin-only category (harvested): By System Admin = 10130, reason "Test Booking" = 12018. Not exposed
  // to the dispatcher's spoken-reason mapping (not a customer-facing cancel reason).
};

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
function easternDayID(offset = 0): string {
  const s = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/); if (!m) return '';
  const dt = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2] + offset));
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;
}
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

// Durable audit of every dispatcher write (move/cancel), incl. dry-runs. BEST-EFFORT: a failure here
// must NEVER block or fail the actual Vonigo write — it only logs. (Table: dispatch_audit, migration 0024.)
async function audit(row: { franchiseID: string; action: string; commandText?: string | null; resolved?: unknown; fieldsWritten?: unknown; vonigoErrno?: number | null; success: boolean; dryRun?: boolean; result?: unknown; actorEmail?: string | null }) {
  try {
    const sb = supa();
    let franchise_id: string | null = null, tenant_id: string | null = TENANT_ID;
    try { const { data: fr } = await sb.from('franchises').select('id, tenant_id').eq('external_id', row.franchiseID).eq('tenant_id', TENANT_ID).single(); if (fr) { franchise_id = fr.id; tenant_id = fr.tenant_id; } } catch { /* best-effort */ }
    await sb.from('dispatch_audit').insert({ tenant_id, franchise_id, franchise_external_id: row.franchiseID, actor_email: row.actorEmail ?? null, action: row.action, command_text: row.commandText ?? null, resolved: row.resolved ?? null, fields_written: row.fieldsWritten ?? null, vonigo_errno: row.vonigoErrno ?? null, success: row.success, dry_run: row.dryRun ?? false, result: row.result ?? null });
  } catch (e) { console.error('[dispatch][audit] failed (non-fatal):', (e as Error).message); }
}

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
    return { jobID: jobRel ? String(jobRel.objectID) : null, woID: String(w.objectID), route: routeRel ? routeRel.name : '', routeCode: shortRoute(routeRel ? routeRel.name : ''), routeID: routeRel ? String(routeRel.objectID) : null, timeMin, timeLabel: timeLabel(timeMin), durationMin: parseInt(gf(f, F.duration).fieldValue || '0', 10), client: gf(f, F.client).fieldValue || '', address: addr, zip: zipOf(addr), price: gf(f, F.price).fieldValue || '', status: gf(f, F.status).fieldValue || '', statusOptionID: gf(f, F.status).optionID || 0, lat: null as number | null, lon: null as number | null };
  }).filter((j: any) => j.jobID && j.statusOptionID !== 162 && !/URGENTCB/i.test(j.route));
  if (route) { const rc = route.toUpperCase(); jobs = jobs.filter((j: any) => j.routeCode.toUpperCase() === rc || j.route.toUpperCase().includes(rc)); }
  jobs.sort((a: any, b: any) => a.timeMin - b.timeMin);
  if (withCoords) await Promise.all(jobs.map(async (j: any) => { if (j.address) { const g = await geocode(j.address); if (g) { j.lat = g.lat; j.lon = g.lon; } } }));
  return jobs;
}

// Standalone tool fns (shared by the action router AND the Claude executor).
async function resolveJobFn(token: string, franchiseID: string, dayID: string, sel: { route?: string; position?: number; timeMin?: number; jobID?: string }) {
  const jobs = await listRouteJobs(token, franchiseID, dayID, sel.route, false);
  let matches = jobs;
  if (sel.jobID) matches = jobs.filter((j: any) => j.jobID === String(sel.jobID));
  else if (Number.isFinite(sel.timeMin as number)) matches = jobs.filter((j: any) => j.timeMin === Number(sel.timeMin));
  else if (Number.isFinite(sel.position as number)) { const p = Number(sel.position); matches = jobs[p - 1] ? [jobs[p - 1]] : []; }
  if (matches.length === 1) return { resolved: matches[0] };
  return { resolved: null, ambiguous: matches.length > 1, candidates: matches.slice(0, 8) };
}
// Route maps for a day: toId (CODE/"Route 3" -> numeric id) and toCode (id -> display code like MA3ALL).
async function getRouteMap(token: string, dayID: string): Promise<{ toId: Record<string, string>; toCode: Record<string, string> }> {
  const r = await vpost(token, '/resources/routes/', { method: '-1', isCompleteObject: 'true', dayID });
  const toId: Record<string, string> = {}, toCode: Record<string, string> = {};
  for (const x of (r.Routes || [])) {
    const id = String(x.objectID);
    if (x.title) { toId[String(x.title).toUpperCase()] = id; toCode[id] = String(x.title); }
    if (x.name) { toId[String(x.name).toUpperCase()] = id; const num = String(x.name).match(/(\d+)/); if (num) toId['ROUTE ' + num[1]] = id; if (!toCode[id]) toCode[id] = String(x.name); }
  }
  return { toId, toCode };
}
function pickRouteID(toId: Record<string, string>, route?: string): string | undefined {
  if (!route) return undefined;
  if (/^\d+$/.test(route)) return route;
  return toId[route.toUpperCase()] || toId['ROUTE ' + route.replace(/\D/g, '')];
}
async function resolveRouteID(token: string, dayID: string, route?: string): Promise<string | undefined> {
  if (!route) return undefined;
  if (/^\d+$/.test(route)) return route;
  const { toId } = await getRouteMap(token, dayID);
  return pickRouteID(toId, route);
}
async function suggestSlotsFn(token: string, franchiseID: string, dayID: string, durationMin: number, zip?: string, route?: string, serviceTypeID = '11') {
  const ds = dayEpoch(dayID), de = ds + 79200;
  const { toId, toCode } = await getRouteMap(token, dayID);
  const routeID = pickRouteID(toId, route);
  const p: any = { method: '0', dateStart: String(ds), dateEnd: String(de), duration: String(durationMin), locationID: '1', serviceTypeID, pageNo: '1', pageSize: '400' };
  if (zip) p.zip = String(zip);
  if (routeID) p.routeID = String(routeID);
  const a = await vpost(token, '/resources/availability/', p);
  return (a.Availability || []).filter((s: any) => String(s.dayID) === dayID).map((s: any) => ({ routeID: String(s.routeID), routeCode: toCode[String(s.routeID)] || String(s.routeID), startTime: parseInt(s.startTime, 10), label: timeLabel(parseInt(s.startTime, 10)) }));
}

// Claude tool-use loop. READ-only tools; returns a structured {intent, message, plan?} — NEVER executes a write.
async function runCommand(token: string, franchiseID: string, dayID: string, todayDayID: string, transcript: string, history: any[] = []) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const tools = [
    { name: 'resolveJob', description: 'Find the job the user means on a route. Address by stop position (1-based within the route), time (minutes-from-midnight), or jobID.', input_schema: { type: 'object', properties: { route: { type: 'string', description: 'route code e.g. MA1REG, or number "1"' }, position: { type: 'number' }, timeMin: { type: 'number' }, jobID: { type: 'string' }, dayID: { type: 'string', description: 'YYYYMMDD; default = the working day' } }, required: [] } },
    { name: 'listRouteJobs', description: 'List jobs on a route (or all routes) for a day, with times/durations/zip.', input_schema: { type: 'object', properties: { route: { type: 'string' }, dayID: { type: 'string' } }, required: [] } },
    { name: 'suggestSlots', description: 'Open booking slots for a day. Pass zip for the job\'s ZONED routes (normal); omit zip for ALL routes (owner override). route (code like MA3ALL or "Route 3") to check one route.', input_schema: { type: 'object', properties: { dayID: { type: 'string' }, durationMin: { type: 'number' }, zip: { type: 'string' }, route: { type: 'string', description: 'route code e.g. MA3ALL or "Route 3"' } }, required: ['durationMin'] } },
    { name: 'respond', description: 'Call this ONLY when you have a concrete MOVE, DURATION-change, or CANCEL plan ready for the user to confirm — include the plan object. For availability answers or clarifying questions, do NOT call respond; just reply in plain text.', input_schema: { type: 'object', properties: { intent: { type: 'string', enum: ['move', 'cancel', 'duration'] }, message: { type: 'string', description: 'one short sentence confirming what will happen' }, plan: { type: 'object', description: 'MOVE: {kind:"move",woID,jobLabel,fromLabel,toRouteCode,dayID,startTime,startLabel,durationMin,zip,zoned}. CANCEL: {kind:"cancel",jobID,jobLabel,category,reason,comments}. DURATION: {kind:"duration",woID,jobLabel,routeCode,dayID,startTime,startLabel,fromDurationMin,durationMin,zip} — woID is the WorkOrder id; routeCode/dayID/startTime stay the job\'s CURRENT values; durationMin is the NEW length in minutes.' } }, required: ['intent', 'message', 'plan'] } },
    { name: 'showJobs', description: 'Use this to ANSWER a "what jobs are on <route> [on <day>]" request — the app renders a clean expandable list, so do NOT list jobs in text and do NOT also call listRouteJobs. Pass the route code (omit to list all routes that day) and dayID.', input_schema: { type: 'object', properties: { route: { type: 'string', description: 'route code e.g. RE-SCD; omit for all routes' }, dayID: { type: 'string' } }, required: [] } },
  ];
  // Server-computed day table (TZ-correct) so the AI never does date math — it just looks up day names.
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayTable = Array.from({ length: 14 }, (_, k) => { const id = easternDayID(k); const dt = new Date(Date.UTC(+id.slice(0, 4), +id.slice(4, 6) - 1, +id.slice(6, 8))); return `${id}=${WD[dt.getUTCDay()]} ${+id.slice(4, 6)}/${+id.slice(6, 8)}${k === 0 ? '(today)' : k === 1 ? '(tomorrow)' : ''}`; }).join(', ');
  const system = `You are CrewLogic's job dispatcher for a junk-removal franchise. The user speaks a command to MOVE a job, change a job's DURATION, CANCEL a job, or ASK what's available. Today = ${todayDayID}; the working day defaults to ${dayID} (YYYYMMDD) unless the user names another day. To resolve a day the user names (e.g. "Monday", "tomorrow", "the 23rd"), use ONLY this server-provided table — never compute dates yourself: ${dayTable}. Times are minutes-from-midnight (540=9AM, 660=11AM, 780=1PM). Route codes: MA1REG, MA2FAR, MA3ALL, MA6REG, RI4REG, RI5FAR, EST, RE-SCD ("route 1"=MA1REG ... "route 6"=MA6REG).

Use the read tools to resolve. You NEVER execute changes — you only RESOLVE and PROPOSE a plan for the human to confirm.

GUARDRAIL — NEVER GUESS the JOB, ROUTE, DAY, or TIME. If the user did not clearly specify one, ASK a clarifying question (intent "clarify") — do not pick for them. Specifically:
- JOB: resolve only by an EXACT unambiguous match (stop position / time / jobID). If zero or MORE THAN ONE job matches, ASK which — never assume.
- ROUTE: if the user does not name a target route, ASK (keep current vs a different/zoned route) — never choose a route yourself.
- DAY / TIME: the ONLY allowed defaults are keep-current — if no new TIME is given keep the job's current time; if no new DAY is given keep the job's current day. These are not guesses, and they are ALWAYS shown in the confirm. Do not invent any other day/time.
Everything in the final plan must appear in the confirm message so the human verifies before anything changes.
- MOVE: resolveJob (positional/time). TIME default: if no new time is named, keep the job's CURRENT time. Always use the job's duration. TWO cases for the target ROUTE:
  (a) User NAMES a route: use it. Check open slots via suggestSlots(route=that route, NO zip) — never pass the zip when checking a NAMED route (zip-zoning hides non-zoned routes like RE-SCD and would falsely show "no slots"). Set zoned by calling suggestSlots(zip=job's zip): zoned=true if the named route appears in those, else zoned=false (owner OVERRIDE — still allowed if the slot is open; flag it). RE-SCD/Estimate are never zoned.
  (b) User does NOT name a target route: ASK FIRST (intent "clarify") whether to keep the job on its CURRENT route or move it to a different (zoned) route — e.g. "Keep this on RE-SCD, or move it to one of its zoned routes?" You MAY note which zoned routes have the requested time open (from suggestSlots WITH the job's zip). Do NOT pick a route yourself yet. After the user answers: "same/keep" -> check the CURRENT route (suggestSlots route=current, NO zip) and propose; "different/zoned/move it" -> use the zoned routes (suggestSlots with the zip): if exactly ONE has the time open propose it, if MULTIPLE ask which, if NONE offer the nearest open times.
  If the requested time isn't open, offer the nearest open times.
- DURATION change ("change/shorten/lengthen the duration to X", "make it one hour", "cut it to 90 minutes"): resolveJob to identify the EXACT job (same JOB rule — resolve only on an unambiguous match, else ASK). KEEP the job's CURRENT route, day, and start time (do not move it). Parse the new length to MINUTES ("one hour"/"an hour"=60, "90 minutes"/"an hour and a half"=90, "two hours"=120, "45 minutes"=45). Build a DURATION plan with woID = the WorkOrder id, routeCode/dayID/startTime = the job's CURRENT values, fromDurationMin = the job's current duration, durationMin = the NEW minutes, and the job's zip. Lengthening can fail if the longer slot isn't open — that's fine, it will be reported on execute.
- CANCEL: resolveJob, then map the spoken reason to a category+reason from this list (case-insensitive): ${JSON.stringify(Object.fromEntries(Object.entries(REASON_CODES).map(([c, v]) => [c, Object.keys(v.reasons)])))}.
- LISTING jobs ("what jobs are on RE-SCD tomorrow", "what's on route 3"): call showJobs(route, dayID) — the app renders a clean expandable list. Do NOT list them in text and do NOT call listRouteJobs for this.
- FOLLOW-UP after a list: a prior assistant turn may contain the exact jobs just listed (number, time, client, route code, JobID, WO id, zip, duration). When the user references one of them ("the second job", "Melissa's job", "move that 11 AM"), resolve it from THAT remembered list — match by the client name or position they used — and use its details directly. Do not re-list; do not ask which job if the remembered list makes it unambiguous. IMPORTANT for a MOVE plan: the plan's woID MUST be the remembered WO id (not the JobID) — a move acts on the WorkOrder. For a CANCEL plan use the JobID.
- AVAILABILITY question (open slots/times): answer from suggestSlots in plain text.

TO FINISH: if (and only if) you have a concrete MOVE, DURATION, or CANCEL plan ready to confirm, call the "respond" tool with intent (move|cancel|duration) + the plan. For an AVAILABILITY answer or a CLARIFYING question, reply in plain text and SHOW the options (route CODES like MA1REG/MA6REG — never raw route ID numbers — and the open times) to help the user decide.
YOUR PLAIN-TEXT REPLY IS SHOWN VERBATIM TO THE USER — it must contain ONLY the final answer or question. Do NOT narrate your steps or thinking: no "let me check…", "before I…", "actually…", no minutes-from-midnight math, no tool talk. Do all checking SILENTLY via the tools first, then give one clean reply.
FORMAT for a NARROW PHONE SCREEN: NEVER use markdown tables or "|" pipe characters. Use short lines or simple "•" bullets, ONE job/option per line, e.g. "• 12:00 PM · Dennis, Charles · Lakeville 02347 · 90 min (Job 855649)". Lead with a one-line summary, then the bulleted list. Keep it brief.`;
  // Seed with prior plain-text turns (conversation memory) so "that job"/"it" resolves.
  const messages: any[] = [];
  for (const h of (Array.isArray(history) ? history.slice(-6) : [])) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    const text = String(h.text || h.content || '').slice(0, 800);
    if (text) messages.push({ role, content: text });
  }
  messages.push({ role: 'user', content: transcript });
  for (let i = 0; i < 6; i++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, tools, messages }) });
    const data = await res.json();
    if (data.type === 'error' || !data.content) throw new Error('Anthropic error: ' + JSON.stringify(data).slice(0, 200));
    messages.push({ role: 'assistant', content: data.content });
    // Terminal: the AI called respond() with its final structured answer.
    const respondBlock = data.content.find((b: any) => b.type === 'tool_use' && b.name === 'respond');
    if (respondBlock) return respondBlock.input || { intent: 'error', message: 'No answer produced.' };
    const showBlock = data.content.find((b: any) => b.type === 'tool_use' && b.name === 'showJobs');
    if (showBlock) {
      const a = showBlock.input || {};
      const d = String(a.dayID || dayID);
      const jobs = await listRouteJobs(token, franchiseID, d, a.route ? String(a.route) : undefined, false);
      const WD2 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dt = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)));
      const dayLabel = `${WD2[dt.getUTCDay()]} ${+d.slice(4, 6)}/${+d.slice(6, 8)}`;
      return { intent: 'jobs', route: a.route || '', dayID: d, dayLabel, jobs: jobs.map((j: any) => ({ jobID: j.jobID, woID: j.woID, client: j.client, address: j.address, zip: j.zip, timeLabel: j.timeLabel, durationMin: j.durationMin, routeCode: j.routeCode, status: j.status })) };
    }
    if (data.stop_reason === 'tool_use') {
      const results: any[] = [];
      for (const block of data.content) {
        if (block.type !== 'tool_use' || block.name === 'respond') continue;
        const a = block.input || {};
        const d = String(a.dayID || dayID);
        let out: any;
        try {
          if (block.name === 'resolveJob') out = await resolveJobFn(token, franchiseID, d, a);
          else if (block.name === 'listRouteJobs') out = { jobs: await listRouteJobs(token, franchiseID, d, a.route, false) };
          else if (block.name === 'suggestSlots') out = { slots: await suggestSlotsFn(token, franchiseID, d, Number(a.durationMin || 120), a.zip, a.route) };
          else out = { error: 'unknown tool' };
        } catch (e) { out = { error: (e as Error).message }; }
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out).slice(0, 6000) });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    // final text → parse JSON
    const text = (data.content.find((b: any) => b.type === 'text') || {}).text || '';
    // Robust extract: strip fences, take the first BALANCED {...} (handles leading/trailing prose).
    let jt = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const st = jt.indexOf('{');
    if (st >= 0) {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = st; i < jt.length; i++) { const c = jt[i]; if (esc) { esc = false; continue; } if (c === '\\') { esc = true; continue; } if (c === '"') { inStr = !inStr; continue; } if (inStr) continue; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { end = i; break; } } }
      jt = end >= 0 ? jt.slice(st, end + 1) : jt.slice(st);
    }
    // If it's JSON (a plan), use it; otherwise it's a natural-language clarify/availability answer — show it.
    // Plain-text clarify/availability: keep line breaks (so bullet lists render), strip markdown bold + stray table pipes.
    try { return JSON.parse(jt); } catch { return { intent: 'info', message: text.replace(/\*\*/g, '').replace(/^\s*\|.*\|\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim() || 'Okay.' }; }
  }
  return { intent: 'error', message: 'Too many steps resolving the command.' };
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
      await audit({ franchiseID, action: 'move', actorEmail: body.actorEmail, commandText: body.commandText, resolved: { ...plan, lockID }, fieldsWritten: { method: 16, objectID: String(woID), lockID: String(lockID) }, vonigoErrno: mv.errNo, success: ok, result: { errMsg: mv.errMsg || null, errors: mv.Errors || null } });
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
      await audit({ franchiseID, action: 'cancel', actorEmail: body.actorEmail, commandText: body.commandText, resolved: plan, fieldsWritten: { method: 4, objectID: String(jobID), Fields }, vonigoErrno: c.errNo, success: ok, result: { errMsg: c.errMsg || null, errors: c.Errors || null } });
      return json({ success: ok, plan, cancel: { errNo: c.errNo, errMsg: c.errMsg || null, errors: c.Errors || null } }, ok ? 200 : 502);
    }

    if (action === 'command') {
      const transcript = String(body.transcript || '').trim();
      if (!transcript) return json({ success: false, error: 'transcript required' }, 400);
      const dayID = String(body.dayID || easternDayID(0));
      const result = await runCommand(token, franchiseID, dayID, easternDayID(0), transcript, body.history || []);
      return json({ success: true, ...result });
    }

    // execute a CONFIRMED plan (the only place a write happens). plan from a prior `command`.
    if (action === 'execute') {
      const plan = body.plan || {};
      if (plan.kind === 'move') {
        const { woID, dayID, startTime } = plan;
        const duration = String(plan.durationMin || 90), zip = String(plan.zip || ''), serviceTypeID = String(plan.serviceTypeID || '11');
        const toRouteID = await resolveRouteID(token, String(dayID), String(plan.toRouteCode || plan.toRouteID || ''));
        if (!woID || !toRouteID || !dayID || startTime == null) return json({ success: false, error: 'move plan missing woID / resolvable toRouteCode / dayID / startTime', toRouteID }, 400);
        const lock = await vpost(token, '/resources/availability/', { method: '2', dayID: String(dayID), routeID: String(toRouteID), zip, serviceTypeID, duration, startTime: String(startTime) });
        const lockID = lock.Ids && (lock.Ids.lockID || lock.Ids.LockID);
        if (!lockID) return json({ success: false, error: 'target slot no longer available', lock: { errNo: lock.errNo, errors: lock.Errors || null } }, 409);
        const mv = await vpost(token, '/data/WorkOrders/', { method: '16', objectID: String(woID), lockID: String(lockID) });
        const ok = mv.errNo === 0;
        console.log(`[dispatch][AUDIT] execute move wo=${woID} route=${toRouteID} ${plan.startLabel} ${dayID} lock=${lockID} errNo=${mv.errNo}`);
        await audit({ franchiseID, action: 'move', actorEmail: body.actorEmail, commandText: body.commandText, resolved: { ...plan, toRouteID, lockID }, fieldsWritten: { method: 16, objectID: String(woID), lockID: String(lockID) }, vonigoErrno: mv.errNo, success: ok, result: { errMsg: mv.errMsg || null, errors: mv.Errors || null } });
        return json({ success: ok, kind: 'move', plan, move: { errNo: mv.errNo, errMsg: mv.errMsg || null, errors: mv.Errors || null } }, ok ? 200 : 502);
      }
      if (plan.kind === 'cancel') {
        const cat = String(plan.category || '').toLowerCase().trim();
        const reason = String(plan.reason || '').toLowerCase().trim();
        const catEntry = REASON_CODES[cat];
        if (!catEntry) return json({ success: false, error: 'unknown cancel category: ' + plan.category }, 400);
        const categoryOptionID = catEntry.categoryOptionID;
        const reasonOptionID = catEntry.reasons[reason];
        if (categoryOptionID == null || reasonOptionID == null) return json({ success: false, error: 'reason code not yet configured', need: { category: plan.category, reason: plan.reason, categoryOptionID, reasonOptionID }, hint: 'fill the optionID in REASON_CODES' }, 422);
        const Fields: any[] = [{ fieldID: 974, optionID: String(categoryOptionID) }, { fieldID: 975, optionID: String(reasonOptionID) }];
        if (plan.comments) Fields.push({ fieldID: 973, fieldValue: String(plan.comments) });
        const c = await vpost(token, '/data/Jobs/', { method: '4', objectID: String(plan.jobID), Fields });
        const ok = c.errNo === 0;
        console.log(`[dispatch][AUDIT] execute cancel job=${plan.jobID} ${cat}/${reason} errNo=${c.errNo}`);
        await audit({ franchiseID, action: 'cancel', actorEmail: body.actorEmail, commandText: body.commandText, resolved: { jobID: String(plan.jobID), category: cat, reason, categoryOptionID, reasonOptionID, comments: plan.comments || null }, fieldsWritten: { method: 4, objectID: String(plan.jobID), Fields }, vonigoErrno: c.errNo, success: ok, result: { errMsg: c.errMsg || null, errors: c.Errors || null } });
        return json({ success: ok, kind: 'cancel', plan, cancel: { errNo: c.errNo, errMsg: c.errMsg || null, errors: c.Errors || null } }, ok ? 200 : 502);
      }
      if (plan.kind === 'duration') {
        // Duration change = direct field edit of the WorkOrder duration (field 186) via method 2 (Edit) —
        // the same proven edit pattern as the National Accounts summary write. The slot does NOT move, so
        // we deliberately do NOT use the lock+method16 reschedule path (the same-start re-lock is rejected
        // because the job already occupies that instant).
        const { woID } = plan;
        const duration = String(plan.durationMin || '');
        if (!woID || !duration) return json({ success: false, error: 'duration plan missing woID / durationMin' }, 400);
        const Fields = [{ fieldID: 186, fieldValue: duration }];
        const ed = await vpost(token, '/data/WorkOrders/', { method: '2', objectID: String(woID), Fields });
        const ok = ed.errNo === 0;
        console.log(`[dispatch][AUDIT] execute duration wo=${woID} -> ${duration}min (field 186, method 2) errNo=${ed.errNo}`);
        await audit({ franchiseID, action: 'duration', actorEmail: body.actorEmail, commandText: body.commandText, resolved: { ...plan }, fieldsWritten: { method: 2, objectID: String(woID), Fields }, vonigoErrno: ed.errNo, success: ok, result: { errMsg: ed.errMsg || null, errors: ed.Errors || null } });
        return json({ success: ok, kind: 'duration', plan, edit: { errNo: ed.errNo, errMsg: ed.errMsg || null, errors: ed.Errors || null } }, ok ? 200 : 502);
      }
      return json({ success: false, error: 'execute needs plan.kind = move | duration | cancel' }, 400);
    }

    return json({ success: false, error: 'unknown action: ' + action }, 400);
  } catch (e) {
    const err = e as Error;
    console.error('[dispatch] error:', err?.stack || err?.message || String(e));
    return json({ success: false, error: err.message || String(e) }, 500);
  }
});
