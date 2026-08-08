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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  const reqId = crypto.randomUUID().slice(0, 8);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    const franchiseID = String(body.franchiseID || '').trim();
    if (!action) return jsonResponse({ success: false, error: 'action required', reqId }, 400);
    if (!franchiseID) return jsonResponse({ success: false, error: 'franchiseID required', reqId }, 400);

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: franchiseRow, error: franchiseErr } = await supabase
      .from('franchises').select('id').eq('external_id', franchiseID).eq('tenant_id', TENANT_ID).single();
    if (franchiseErr || !franchiseRow) return jsonResponse({ success: false, error: 'Franchise not found: ' + franchiseID, reqId }, 404);

    const creds = await resolveCreds(supabase, (franchiseRow as { id: string }).id);
    if (!creds) return jsonResponse({ success: false, error: 'Vonigo credentials not found for franchise ' + franchiseID, reqId }, 404);
    const token = await vonigoLogin(creds.vonigo_username, creds.vonigo_md5);

    // ---------- action: list ----------
    if (action === 'list') {
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

    return jsonResponse({ success: false, error: 'Unknown action: ' + action, reqId }, 400);
  } catch (e) {
    if (e instanceof VonigoUnavailable) return jsonResponse(VONIGO_DOWN_BODY, 503);
    console.error(`[ny-estimate][${reqId}] ${(e as Error).message}`, e);
    return jsonResponse({ success: false, error: 'internal_error', reqId }, 500);
  }
});
