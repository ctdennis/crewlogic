// Supabase Edge Function: crewlogic-ny-estimate (v1.0) — P1 ingestion for "Estimate Costing"
// (internal name: reverse-estimate mode). Pulls a Vonigo-first estimate + its photos into a
// CrewLogic structure so the app can run photo→AI volume + margin (later phases). READ-ONLY to
// Vonigo. See docs/plan-ny-estimate.md.
//
// Deploy (dev):  bash supabase/dev-setup/deploy-fn.sh crewlogic-ny-estimate dev
//   (server-to-server Vonigo auth, called by the authenticated app — NOT a public webhook.)
//
// Actions:
//   { action: 'list', franchiseID, date?: 'YYYY-MM-DD', dayOffset?: number }
//     → COSTABLE estimates for that day: label 9996 "Estimate Completed (Est. Only)" AND has photos.
//       Purple 9973 "Estimate Only" (pre-visit, no photos) is excluded. Deduped by job; photos live on
//       the QUOTE object.
//     Response: { success, estimates: [ { jobID, workOrderID, appointmentName, clientName, address,
//                 zip, route, labelOptionID, labelName, status, dateService, timeLabel,
//                 photoCount, hasPhotos } ] }
//
//   { action: 'load', franchiseID, jobID }
//     → one estimate's full structure + its photo download URLs.
//     Response: { success, estimate: { jobID, workOrderID, quoteID, clientName, contactName,
//                 address, zip, route, labelOptionID, labelName, dateService, existingPrice },
//                 photos: [ { objectID, fileName, downloadUrl } ], photoCount }
//
// Vonigo facts this relies on (verified 2026-08-08, #90 — see docs/plan-ny-estimate.md):
//   - Costable estimates carry label 9996 "Estimate Completed (Est. Only)" (yellow-green) — the stage where
//     the estimate has been performed and photos loaded. (Route "Estimate (EST)" objectID 3848 is used only to
//     prefer the estimate WO when deduping.)
//   - Resolve a job → its WO via POST /data/WorkOrders/ {jobID}. Address = field 184; zip via the
//     state-anchored /\b[A-Z]{2}\s+(\d{5})\b/. The `quote` relation gives the quoteID.
//   - PHOTOS HANG OFF THE QUOTE, not the WorkOrder: POST /data/documents/ {method:-1, quoteID}
//     (or {jobID}) → Documents[]; each doc's `name` is the download URL
//     (…/api/Download/?<GUID>#<filename>), self-authenticating. `workOrderID` returns 0 docs.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { vonigoJson, VonigoUnavailable, VONIGO_DOWN_BODY } from '../_shared/vonigo.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TENANT_ID = '946a4535-aa61-45b6-a6fb-9190ff546d41'; // Junkluggers
const VONIGO_BASE = 'https://junkluggers.vonigo.com/api/v1';

// Vonigo fieldIDs (objectTypeID 19 WorkOrder)
const F_STATUS = 181;
const F_ADDRESS = 184;
const F_DATE_SERVICE = 185;
const F_TIME_MINUTES = 9082; // minutes from franchise-local midnight
const F_PRICE = 813;
const F_LABEL = 201;

// Costable estimates = the "Estimate Completed (Est. Only)" stage (9996, yellow-green): the estimate has
// been PERFORMED and photos loaded. Purple 9973 "Estimate Only" (pre-visit, no quote, no photos) is
// intentionally EXCLUDED — this feature is only for estimates that actually have photos (owner 2026-08-08).
// `list` further requires photoCount > 0, so photo-less 9996s are dropped too.
const EST_ROUTE_ID = 3848;                 // route "Estimate (EST)" — used only to prefer the estimate WO on dedup
const COSTABLE_LABELS = new Set([9996]);   // 9996 Est-Completed-EstOnly (yellow-green)
const LABEL_NAMES: Record<number, string> = {
  9973: 'Estimate Only',
  9996: 'Estimate Completed (Est. Only)',
  245: 'Estimate Completed (Job)',
  9970: 'Estimate Converted (Est. Only)',
  9975: 'Estimate Converted (Job)',
  9993: 'Lost',
  9984: 'New Appointment',
};
const STATUS_COMPLETED = 164;
const STATUS_ARCHIVED = 165;

// ── P2: AI grouping + de-dup ──────────────────────────────────────────────────
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL_GROUP = 'claude-haiku-4-5-20251001'; // Pass 1 grouping — cheap; not the customer number (estimator gate catches misclusters)
const MODEL_QUANTIFY = 'claude-sonnet-4-6';       // Pass 2 volume — identifier-adjacent (price rides on it) → Sonnet+
const TRUCK_CY = 16;  // Vonigo pricing truck
const EIGHTH_CY = 2;  // 1/8 of a 16 cu yd truck

// Canonical room taxonomy — the grouper labels from THIS list, and it's the P3 dropdown's option set
// (single source of truth). Multiple bedrooms → "Bedroom 1".."Bedroom 8"; the main one → "Primary Bedroom".
const ROOM_TAXONOMY = [
  'Primary Bedroom', 'Bedroom 1', 'Bedroom 2', 'Bedroom 3', 'Bedroom 4', 'Bedroom 5', 'Bedroom 6', 'Bedroom 7', 'Bedroom 8',
  'Kitchen', 'Breakfast Nook', 'Dining Room', 'Pantry',
  'Living Room', 'Family Room', 'Den', 'Sunroom', 'Office', 'Playroom',
  'Foyer', 'Entry', 'Mudroom', 'Breezeway', 'Hallway', 'Stairway', 'Landing',
  'Basement', 'Attic', 'Garage', 'Laundry Room', 'Workshop', 'Storage Room', 'Closet', 'Bathroom',
  'Deck / Patio', 'Front Yard', 'Side Yard', 'Back Yard', 'Driveway', 'Parking Lot', 'Shed',
  'Other',
];

interface VonigoField { fieldID: number; fieldValue: string | null; optionID: number; }
interface VonigoRelation { objectTypeID: number; objectID: number | string; name: string; relationType: string; isActive: boolean; }
interface VonigoWorkOrder { objectID: string; name?: string; Fields: VonigoField[]; Relations: VonigoRelation[]; }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function getField(fields: VonigoField[], id: number): VonigoField | undefined {
  return fields.find((f) => f.fieldID === id);
}
function rel(relations: VonigoRelation[], type: string): VonigoRelation | undefined {
  return relations.find((r) => r.relationType === type);
}
function zipFromAddress(addr: string): string {
  const m = /\b[A-Z]{2}\s+(\d{5})\b/.exec(addr || '');
  return m ? m[1] : '';
}
function timeLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return '';
  const h24 = Math.floor(minutes / 60) % 24;
  const mm = Math.floor(minutes % 60);
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 === 0 ? 12 : (h24 > 12 ? h24 - 12 : h24);
  return `${h12}:${mm.toString().padStart(2, '0')} ${ampm}`;
}
// Naive clock-face epoch for a Y/M/D (Vonigo's date-field convention: local wall-clock treated as UTC).
function naiveDayEpoch(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d, 0, 0, 0) / 1000);
}
function isCostableEstimate(wo: VonigoWorkOrder): boolean {
  const label = getField(wo.Fields || [], F_LABEL)?.optionID || 0;
  return COSTABLE_LABELS.has(label);
}

// Resolve Vonigo credentials for a franchise (same cascade as crewlogic-todays-workorders).
async function resolveCreds(supabase: ReturnType<typeof createClient>, franchiseInternalId: string) {
  const { data: credRows, error: credErr } = await supabase
    .rpc('get_vonigo_credential', { franchise_id_param: franchiseInternalId });
  if (!credErr && credRows && credRows.length > 0) return credRows[0];
  for (const p of ['p_franchise_id', 'franchise_id', 'franchiseid', 'fid']) {
    const args: Record<string, string> = {}; args[p] = franchiseInternalId;
    const r = await supabase.rpc('get_vonigo_credential', args);
    if (!r.error && r.data && r.data.length > 0) return r.data[0];
  }
  const { data: directRows } = await supabase
    .from('vonigo_credentials').select('vonigo_username, vonigo_md5')
    .eq('franchise_id', franchiseInternalId).limit(1);
  if (directRows && directRows.length > 0) return directRows[0];
  return null;
}

async function vonigoLogin(username: string, md5: string): Promise<string> {
  const url = new URL(VONIGO_BASE + '/security/login/');
  url.searchParams.set('company', 'Vonigo');
  url.searchParams.set('userName', username);
  url.searchParams.set('password', md5);
  const data = await vonigoJson(await fetch(url.toString()));
  if (data.errNo !== 0 || !data.securityToken) throw new Error('vonigo_auth_failed: ' + (data.errMsg || 'no token'));
  return data.securityToken;
}
async function vonigoPost(path: string, body: Record<string, unknown>) {
  return await vonigoJson(await fetch(VONIGO_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}
// List a job's photo documents (they hang off the QUOTE; jobID resolves to the same set).
async function listDocs(token: string, keyName: 'quoteID' | 'jobID', keyVal: string) {
  const d = await vonigoPost('/data/documents/', { securityToken: token, method: '-1', [keyName]: keyVal, isCompleteObject: 'true', pageSize: '200' });
  const docs: Array<{ objectID: number | string; name?: string }> = d.Documents || [];
  return docs
    .filter((x) => typeof x.name === 'string' && x.name.startsWith('http'))
    .map((x) => {
      const url = String(x.name);
      const fileName = url.includes('#') ? decodeURIComponent(url.split('#').pop() || '') : '';
      return { objectID: x.objectID, fileName, downloadUrl: url };
    });
}

// ── AI helpers (P2) ───────────────────────────────────────────────────────────
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
// Download one photo → an Anthropic base64 image block (Vonigo serves octet-stream; the bytes are JPEG).
// NOTE: server-side downscaling (ImageScript) OOM/CPU-limits the edge worker on 40+ images — downscaling is
// done CLIENT-SIDE in P3 (browser canvas) instead, which also lowers AI cost. See docs/plan-ny-estimate.md §5.7.
async function fetchImageBlock(url: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(url);
  if (!r.ok) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  const ct = r.headers.get('content-type') || '';
  const mt = ct.startsWith('image/') ? ct.split(';')[0].trim() : 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: mt, data: uint8ToBase64(bytes) } };
}
async function callAnthropic(model: string, system: string, userContent: unknown, maxTokens: number, label: string): Promise<Record<string, unknown>> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userContent }] }),
  });
  if (!res.ok) {
    const bodyText = await res.text();
    console.error(`[ny-estimate:${label}] Anthropic ${res.status} (request-id: ${res.headers.get('request-id') || 'n/a'}): ${bodyText.slice(0, 500)}`);
    throw new Error(`AI request failed (Anthropic ${res.status})`);
  }
  const result = await res.json() as Record<string, unknown>;
  if (result && (result.error || result.type === 'error')) {
    throw new Error(((result.error as Record<string, unknown>)?.message as string) || 'Anthropic returned an error');
  }
  return result;
}
function anthropicText(result: Record<string, unknown>): string {
  const content = (result?.content as Array<Record<string, unknown>>) || [];
  return content.filter((b) => b.type === 'text').map((b) => String(b.text || '')).join('\n');
}
function anthropicUsage(result: Record<string, unknown>): { tokens_in: number; tokens_out: number } {
  const u = (result?.usage as Record<string, number>) || {};
  return { tokens_in: Number(u.input_tokens || 0), tokens_out: Number(u.output_tokens || 0) };
}
// Extract the first JSON object/array from a model reply (tolerates ``` fences / prose).
function parseJsonLoose(text: string): unknown {
  const t = String(text || '').replace(/```json/gi, '```').replace(/```/g, '');
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0);
  if (starts.length === 0) throw new Error('no JSON in AI reply');
  const start = Math.min(...starts);
  const open = t[start]; const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === open) depth++;
    else if (t[i] === close) { depth--; if (depth === 0) return JSON.parse(t.slice(start, i + 1)); }
  }
  throw new Error('unterminated JSON in AI reply');
}

interface Img { index: number; objectID: string | number; fileName: string; block: Record<string, unknown>; }

// Download an estimate's photos (off the QUOTE via jobID) into indexed image blocks (parallel).
async function downloadPhotos(token: string, jobID: string): Promise<Img[]> {
  const docs = await listDocs(token, 'jobID', jobID);
  const blocks = await Promise.all(docs.map((d) => fetchImageBlock(d.downloadUrl).catch(() => null)));
  const imgs: Img[] = [];
  let i = 0;
  for (let k = 0; k < docs.length; k++) {
    if (blocks[k]) imgs.push({ index: i++, objectID: docs[k].objectID, fileName: docs[k].fileName, block: blocks[k]! });
  }
  return imgs;
}
// Build image blocks from CLIENT-provided base64 (the browser downscales the photos → much cheaper AI + no
// server-side image download/decode). Each item: { index, b64 } (b64 may include a data: prefix).
function imgsFromClient(images: Array<{ index?: number; b64?: string }>): Img[] {
  return (images || []).map((im, k) => ({
    index: (im.index != null ? im.index : k),
    objectID: '', fileName: '',
    block: { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: String(im.b64 || '').replace(/^data:image\/\w+;base64,/, '') } },
  }));
}
// §6 billing preview (final pricing is P4): min 1 cu yd, else round up to the next 1/8-truck (2 cu yd) step.
function billedCuyd(total: number): number {
  if (total <= 1) return 1;
  return Math.ceil(total / EIGHTH_CY) * EIGHTH_CY;
}
// Run fn over items with bounded concurrency (Anthropic rate-limits ~many parallel calls).
async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array(items.length) as R[];
  let idx = 0;
  async function worker() { while (idx < items.length) { const cur = idx++; results[cur] = await fn(items[cur], cur); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

const GROUP_SYSTEM =
  'You are a junk-removal estimator grouping site photos by physical room/area. The photos come from ONE ' +
  'estimate and may show each room from several angles or in close-up. Do NOT rely on any filename — judge ' +
  'from the image content only. Group photos that show the same physical space together.';
async function doGroup(imgs: Img[]): Promise<{ groups: Array<{ room_label: string; photo_indices: number[]; confidence?: number; note?: string }>; usage: { tokens_in: number; tokens_out: number } }> {
  const content: unknown[] = [];
  for (const im of imgs) { content.push({ type: 'text', text: `Photo [${im.index}]` }); content.push(im.block); }
  content.push({ type: 'text', text:
    `The ${imgs.length} photos above (labeled Photo [0]..[${imgs.length - 1}]) are from ONE junk-removal estimate. ` +
    'Group them by physical room/area. Make ONE group per distinct room — do NOT split a single room into multiple ' +
    'groups for different corners, angles, or zones; all photos of the same physical space go in ONE group. Every ' +
    'photo index must appear in EXACTLY ONE group (never in two, and do not omit any index). ' +
    'Label each group with EXACTLY one name from this list: ' + ROOM_TAXONOMY.join(', ') + '. ' +
    'For additional bedrooms use "Bedroom 1", "Bedroom 2", etc.; the main/largest bedroom is "Primary Bedroom". ' +
    'If a space matches none, use "Other". Return ONLY JSON, no prose: ' +
    '{"groups":[{"room_label":"string","photo_indices":[int,...],"confidence":0..1,"note":"string"}]}' });
  const result = await callAnthropic(MODEL_GROUP, GROUP_SYSTEM, content, 1500, 'group');
  const parsed = parseJsonLoose(anthropicText(result)) as { groups?: Array<{ room_label: string; photo_indices: number[]; confidence?: number; note?: string }> };
  return { groups: parsed.groups || [], usage: anthropicUsage(result) };
}

const QUANTIFY_SYSTEM =
  'You are a junk-removal estimator computing REMOVABLE volume from photos of ONE room. The photos are multiple ' +
  'angles of the SAME space, so an item visible in several photos is the SAME item — count it ONCE. Never sum ' +
  'per-photo volumes. Estimate each removable item\'s volume in cubic yards, then the room total in cubic yards.';
async function doQuantifyRoom(roomLabel: string, imgs: Img[]): Promise<{ room_label: string; items: Array<{ name: string; qty: number; est_cuyd: number }>; volume_cuyd: number; confidence?: number; notes?: string; usage: { tokens_in: number; tokens_out: number } }> {
  const content: unknown[] = [];
  for (const im of imgs) { content.push({ type: 'text', text: `Photo of ${roomLabel}` }); content.push(im.block); }
  content.push({ type: 'text', text:
    `These ${imgs.length} photos all show the same room: "${roomLabel}". Build ONE combined inventory of the ` +
    'removable items, counting each physical item ONCE across all angles. Then give the room\'s total removable ' +
    'volume in cubic yards. Return ONLY JSON, no prose: ' +
    '{"room_label":"string","items":[{"name":"string","qty":int,"est_cuyd":number}],"volume_cuyd":number,"confidence":0..1,"notes":"string"}' });
  const result = await callAnthropic(MODEL_QUANTIFY, QUANTIFY_SYSTEM, content, 1500, 'quantify');
  const p = parseJsonLoose(anthropicText(result)) as { room_label?: string; items?: Array<{ name: string; qty: number; est_cuyd: number }>; volume_cuyd?: number; confidence?: number; notes?: string };
  return { room_label: p.room_label || roomLabel, items: p.items || [], volume_cuyd: Number(p.volume_cuyd || 0), confidence: p.confidence, notes: p.notes, usage: anthropicUsage(result) };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  const reqId = crypto.randomUUID().slice(0, 8);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    const franchiseID = String(body.franchiseID || '').trim();
    if (!action) return jsonResponse({ success: false, error: 'action required', reqId }, 400);
    // Static taxonomy — the P3 room dropdown reads its options from here (single source, no auth/Vonigo needed).
    if (action === 'rooms') return jsonResponse({ success: true, rooms: ROOM_TAXONOMY, reqId });

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    // Lazy Vonigo login — only list/load (and group/quantify WITHOUT client images) need it; group/quantify with
    // client-provided base64 images skip Vonigo entirely (browser already fetched + downscaled the photos).
    let _token: string | null = null;
    async function getToken(): Promise<string> {
      if (_token) return _token;
      if (!franchiseID) throw new Error('franchiseID required');
      const { data: fr, error: fe } = await supabase
        .from('franchises').select('id').eq('external_id', franchiseID).eq('tenant_id', TENANT_ID).single();
      if (fe || !fr) throw new Error('Franchise not found: ' + franchiseID);
      const creds = await resolveCreds(supabase, (fr as { id: string }).id);
      if (!creds) throw new Error('Vonigo credentials not found for franchise ' + franchiseID);
      _token = await vonigoLogin(creds.vonigo_username, creds.vonigo_md5);
      return _token;
    }

    // ---------- action: list ----------
    if (action === 'list') {
      const token = await getToken();
      // Date window (naive clock-face epochs — Vonigo date-field convention).
      let y: number, m: number, d: number;
      const dateStr = String(body.date || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        [y, m, d] = dateStr.split('-').map(Number);
      } else {
        // dayOffset relative to the UTC "today" (server clock). #90 is ET; callers should pass an
        // explicit `date` for correctness across zones — dayOffset is a convenience fallback.
        const off = Number(body.dayOffset) || 0;
        const now = new Date(Date.now() + off * 86400000);
        y = now.getUTCFullYear(); m = now.getUTCMonth() + 1; d = now.getUTCDate();
      }
      const dateStart = naiveDayEpoch(y, m, d);
      const dateEnd = dateStart + 86400;

      // Pull the day's WorkOrders (paginate defensively; a single day is well under one page).
      const all: VonigoWorkOrder[] = [];
      for (let pg = 1; pg <= 5; pg++) {
        const wr = await vonigoPost('/data/WorkOrders/', {
          securityToken: token, franchiseID, pageNo: String(pg), pageSize: '200',
          sortMode: '1', sortDirection: '1', isCompleteObject: 'true',
          dateMode: '3', dateStart: String(dateStart), dateEnd: String(dateEnd),
        });
        if (wr.errNo !== 0) return jsonResponse({ success: false, error: 'Vonigo WorkOrders query failed: ' + (wr.errMsg || 'errNo ' + wr.errNo), reqId }, 502);
        const page: VonigoWorkOrder[] = wr.WorkOrders || [];
        all.push(...page);
        if (page.length < 200) break;
      }

      // Filter to costable estimates (9996 only), dedupe by job (prefer the EST-route WO).
      const byJob: Record<string, VonigoWorkOrder> = {};
      for (const wo of all) {
        if (!isCostableEstimate(wo)) continue;
        const jobRel = rel(wo.Relations || [], 'job');
        const jobID = jobRel?.objectID != null ? String(jobRel.objectID) : String(wo.objectID);
        const existing = byJob[jobID];
        if (!existing) { byJob[jobID] = wo; continue; }
        // prefer the WO that is actually on the EST route
        const onEst = (w: VonigoWorkOrder) => Number(rel(w.Relations || [], 'route')?.objectID) === EST_ROUTE_ID;
        if (onEst(wo) && !onEst(existing)) byJob[jobID] = wo;
      }

      const estimates = [];
      for (const jobID of Object.keys(byJob)) {
        const wo = byJob[jobID];
        const fields = wo.Fields || [];
        const relations = wo.Relations || [];
        const label = getField(fields, F_LABEL)?.optionID || 0;
        const statusOpt = getField(fields, F_STATUS)?.optionID || 0;
        const addr = getField(fields, F_ADDRESS)?.fieldValue || '';
        // photoCount off the QUOTE (via jobID, which returns the quote's docs)
        let photoCount = 0;
        try { photoCount = (await listDocs(token, 'jobID', jobID)).length; } catch (_e) { photoCount = -1; }
        // This feature is only for estimates that actually have photos — drop photo-less ones.
        // (photoCount === -1 = a transient doc-list error; keep it rather than silently hide the estimate.)
        if (photoCount === 0) continue;
        estimates.push({
          jobID,
          workOrderID: wo.objectID,
          appointmentName: wo.name || '',
          clientName: rel(relations, 'client')?.name || '',
          address: addr,
          zip: zipFromAddress(addr),
          route: rel(relations, 'route')?.name || '',
          labelOptionID: label,
          labelName: LABEL_NAMES[label] || (getField(fields, F_LABEL)?.fieldValue || ''),
          status: getField(fields, F_STATUS)?.fieldValue || '',
          statusOptionID: statusOpt,
          isComplete: statusOpt === STATUS_COMPLETED || statusOpt === STATUS_ARCHIVED,
          dateService: parseInt(getField(fields, F_DATE_SERVICE)?.fieldValue || '0', 10),
          timeLabel: timeLabel(parseInt(getField(fields, F_TIME_MINUTES)?.fieldValue || '0', 10)),
          photoCount,
          hasPhotos: photoCount > 0,
        });
      }
      estimates.sort((a, b) => (b.dateService || 0) - (a.dateService || 0));
      return jsonResponse({ success: true, count: estimates.length, estimates, reqId });
    }

    // ---------- action: load ----------
    if (action === 'load') {
      const token = await getToken();
      const jobID = String(body.jobID || '').trim();
      if (!jobID) return jsonResponse({ success: false, error: 'jobID required', reqId }, 400);

      const wr = await vonigoPost('/data/WorkOrders/', {
        securityToken: token, jobID, pageNo: '1', pageSize: '10',
        sortMode: '1', sortDirection: '1', isCompleteObject: 'true',
      });
      if (wr.errNo !== 0) return jsonResponse({ success: false, error: 'Vonigo WorkOrders query failed: ' + (wr.errMsg || 'errNo ' + wr.errNo), reqId }, 502);
      const wos: VonigoWorkOrder[] = wr.WorkOrders || [];
      if (wos.length === 0) return jsonResponse({ success: false, error: 'Estimate not found for job ' + jobID, reqId }, 404);
      // Prefer the estimate WO (EST route), else the first.
      const wo = wos.find((w) => Number(rel(w.Relations || [], 'route')?.objectID) === EST_ROUTE_ID) || wos[0];

      const fields = wo.Fields || [];
      const relations = wo.Relations || [];
      const quoteRel = rel(relations, 'quote');
      const quoteID = quoteRel?.objectID != null ? String(quoteRel.objectID) : '';
      const addr = getField(fields, F_ADDRESS)?.fieldValue || '';
      const label = getField(fields, F_LABEL)?.optionID || 0;

      // Photos: prefer quoteID (canonical), fall back to jobID (returns the same quote docs).
      let photos: Array<{ objectID: number | string; fileName: string; downloadUrl: string }> = [];
      if (quoteID) { try { photos = await listDocs(token, 'quoteID', quoteID); } catch (_e) { photos = []; } }
      if (photos.length === 0) { try { photos = await listDocs(token, 'jobID', jobID); } catch (_e) { /* keep [] */ } }

      const estimate = {
        jobID,
        workOrderID: wo.objectID,
        quoteID,
        appointmentName: wo.name || '',
        clientName: rel(relations, 'client')?.name || '',
        contactName: rel(relations, 'contact')?.name || '',
        address: addr,
        zip: zipFromAddress(addr),
        route: rel(relations, 'route')?.name || '',
        labelOptionID: label,
        labelName: LABEL_NAMES[label] || (getField(fields, F_LABEL)?.fieldValue || ''),
        dateService: parseInt(getField(fields, F_DATE_SERVICE)?.fieldValue || '0', 10),
        existingPrice: parseFloat(getField(fields, F_PRICE)?.fieldValue || '0'),
      };
      return jsonResponse({ success: true, estimate, photos, photoCount: photos.length, reqId });
    }

    // ---------- action: group (Pass 1 — Haiku clusters photos into rooms) ----------
    if (action === 'group') {
      const jobID = String(body.jobID || '').trim();
      const imgs = (Array.isArray(body.images) && body.images.length)
        ? imgsFromClient(body.images)                        // client-downscaled (cheap, preferred)
        : (jobID ? await downloadPhotos(await getToken(), jobID) : []); // legacy: server downloads full-res
      if (imgs.length === 0) return jsonResponse({ success: false, error: 'No photos provided', reqId }, 400);
      const { groups, usage } = await doGroup(imgs);
      const assigned = new Set<number>();
      for (const grp of groups) for (const i of (grp.photo_indices || [])) assigned.add(i);
      const ungrouped = imgs.map((im) => im.index).filter((i) => !assigned.has(i));
      return jsonResponse({
        success: true, jobID,
        photos: imgs.map((im) => ({ index: im.index, objectID: im.objectID, fileName: im.fileName })),
        groups, ungrouped, model: MODEL_GROUP, usage, reqId,
      });
    }

    // ---------- action: quantify (Pass 2 — Sonnet de-dups volume per room) ----------
    if (action === 'quantify') {
      const jobID = String(body.jobID || '').trim();
      const groupsIn = (body.groups as Array<{ room_label: string; photo_indices: number[] }>) || [];
      if (!Array.isArray(groupsIn) || groupsIn.length === 0) return jsonResponse({ success: false, error: 'groups required', reqId }, 400);
      const imgs = (Array.isArray(body.images) && body.images.length)
        ? imgsFromClient(body.images)
        : (jobID ? await downloadPhotos(await getToken(), jobID) : []);
      if (imgs.length === 0) return jsonResponse({ success: false, error: 'No photos provided', reqId }, 400);
      const byIdx = new Map(imgs.map((im) => [im.index, im]));
      const jobs = groupsIn.map((g) => ({ label: g.room_label, imgs: (g.photo_indices || []).map((i) => byIdx.get(i)).filter(Boolean) as Img[] })).filter((j) => j.imgs.length > 0);
      const rooms = await mapPool(jobs, 4, async (j) => {
        try { return await doQuantifyRoom(j.label, j.imgs); }
        catch (err) { return { room_label: j.label, items: [], volume_cuyd: 0, confidence: 0, notes: 'quantify failed: ' + (err as Error).message, usage: { tokens_in: 0, tokens_out: 0 } }; }
      });
      const totalCuyd = rooms.reduce((s, r) => s + (r.volume_cuyd || 0), 0);
      const tokens_in = rooms.reduce((s, r) => s + r.usage.tokens_in, 0);
      const tokens_out = rooms.reduce((s, r) => s + r.usage.tokens_out, 0);
      return jsonResponse({
        success: true, jobID,
        rooms: rooms.map(({ usage: _u, ...r }) => ({ ...r, volume_eighths: +(r.volume_cuyd / EIGHTH_CY).toFixed(2) })),
        totalCuyd: +totalCuyd.toFixed(2), billedCuyd: billedCuyd(totalCuyd), truckFraction: +(totalCuyd / TRUCK_CY).toFixed(3),
        model: MODEL_QUANTIFY, usage: { tokens_in, tokens_out }, reqId,
      });
    }

    // ---------- action: analyze (chain group → quantify; downloads photos once) ----------
    if (action === 'analyze') {
      const jobID = String(body.jobID || '').trim();
      const imgs = (Array.isArray(body.images) && body.images.length)
        ? imgsFromClient(body.images)
        : (jobID ? await downloadPhotos(await getToken(), jobID) : []);
      if (imgs.length === 0) return jsonResponse({ success: false, error: 'No photos provided', reqId }, 400);
      const g = await doGroup(imgs);
      const byIdx = new Map(imgs.map((im) => [im.index, im]));
      // Any photo Haiku left un-grouped → an "Other / Unsorted" bucket so nothing is silently dropped.
      const assigned = new Set<number>();
      for (const grp of g.groups) for (const i of (grp.photo_indices || [])) assigned.add(i);
      const ungrouped = imgs.map((im) => im.index).filter((i) => !assigned.has(i));
      const allGroups = ungrouped.length > 0
        ? [...g.groups, { room_label: 'Other / Unsorted', photo_indices: ungrouped, confidence: 0.3, note: 'Photos the grouper did not assign — review these.' }]
        : g.groups;
      const jobs = allGroups.map((grp) => ({ label: grp.room_label, imgs: (grp.photo_indices || []).map((i) => byIdx.get(i)).filter(Boolean) as Img[] })).filter((j) => j.imgs.length > 0);
      const rooms = await mapPool(jobs, 4, async (j) => {
        try { return await doQuantifyRoom(j.label, j.imgs); }
        catch (err) { return { room_label: j.label, items: [], volume_cuyd: 0, confidence: 0, notes: 'quantify failed: ' + (err as Error).message, usage: { tokens_in: 0, tokens_out: 0 } }; }
      });
      const totalCuyd = rooms.reduce((s, r) => s + (r.volume_cuyd || 0), 0);
      const tokens_in = g.usage.tokens_in + rooms.reduce((s, r) => s + r.usage.tokens_in, 0);
      const tokens_out = g.usage.tokens_out + rooms.reduce((s, r) => s + r.usage.tokens_out, 0);
      return jsonResponse({
        success: true, jobID, photoCount: imgs.length,
        groups: allGroups, ungrouped,
        rooms: rooms.map(({ usage: _u, ...r }) => ({ ...r, volume_eighths: +(r.volume_cuyd / EIGHTH_CY).toFixed(2) })),
        totalCuyd: +totalCuyd.toFixed(2), billedCuyd: billedCuyd(totalCuyd), truckFraction: +(totalCuyd / TRUCK_CY).toFixed(3),
        models: { group: MODEL_GROUP, quantify: MODEL_QUANTIFY }, usage: { tokens_in, tokens_out }, reqId,
      });
    }

    return jsonResponse({ success: false, error: 'Unknown action: ' + action, reqId }, 400);
  } catch (e) {
    if (e instanceof VonigoUnavailable) return jsonResponse(VONIGO_DOWN_BODY, 503);
    console.error(`[ny-estimate][${reqId}] ${(e as Error).message}`, e);
    return jsonResponse({ success: false, error: 'internal_error', reqId }, 500);
  }
});
