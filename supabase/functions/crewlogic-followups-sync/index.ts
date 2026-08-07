// Supabase Edge Function: crewlogic-followups-sync — Vonigo follow-ups pipeline sync (task #28 / docs/plan-followups.md)
//
// P1: SCHEDULING-CANCELS. Pulls the franchise's cancelled WorkOrders in a rolling window, resolves each
// Job by jobID (method 0 — method 1 REFUSES a cancelled job), keeps cancel CATEGORY 974 = "Scheduling"
// (10133), resolves the customer contact (phone field 1088 + email via method 0), and UPSERTS into the
// `followups` table keyed by (franchise_id, kind, source_id) so re-syncs UPDATE, never duplicate. New rows
// get a 'created' event; the human-set status/notes/followup_at are never disturbed on re-sync.
// (Leads / unconverted estimates / UCB / cases land in later phases — same table, same upsert.)
//
// Vonigo recognition detail: memory vonigo-five-type-recognition. Auth: MD5 /security/login (no OAuth).
//
// Action: POST { franchiseID: "90", kinds?: ["cancel"], sinceDays?: 90 }
//   -> { success, franchiseID, results: { cancel: { scanned, scheduling, upserted, inserted } } }
//
// Deploy: bash supabase/dev-setup/deploy-fn.sh crewlogic-followups-sync <dev|prod>

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { vonigoJson, VonigoUnavailable, VONIGO_DOWN_BODY } from '../_shared/vonigo.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const VONIGO_BASE = 'https://junkluggers.vonigo.com/api/v1';

// WorkOrder / Job field IDs (see memory vonigo-status-and-label-codes + vonigo-five-type-recognition).
const F_STATUS = 181, F_CLIENT = 183, F_ADDRESS = 184, F_DATE_SERVICE = 185;
const F_CANCEL_CAT = 974, F_CANCEL_REASON = 975, F_CANCEL_COMMENTS = 973;
const F_CONTACT_PHONE = 1088;
const SCHEDULING_CAT = 10133;                 // 974 optionID for the "Scheduling" cancel category
const CANCELLED = new Set([162, 163]);        // status 181: Cancelled / Cancelled-Today
const UA = 'Mozilla/5.0 (compatible; CrewLogic/1.0)';  // Vonigo's CDN 1010-blocks empty UAs

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function db() { return createClient(SUPABASE_URL, SERVICE_KEY); }

// deno-lint-ignore no-explicit-any
function fval(o: any, fid: number): string | null {
  for (const f of (o?.Fields || [])) if (f.fieldID === fid) return (f.optionID && f.optionID !== 0) ? f.optionID : (f.fieldValue ?? null);
  return null;
}
// deno-lint-ignore no-explicit-any
function ftext(o: any, fid: number): string | null {
  for (const f of (o?.Fields || [])) if (f.fieldID === fid) return f.fieldValue || null;
  return null;
}
// deno-lint-ignore no-explicit-any
function rel(o: any, t: string): any {
  for (const r of (o?.Relations || [])) if (r.relationType === t) return r;
  return {};
}
function epochToISO(v: string | null): string | null {
  const n = Number(v); return (isFinite(n) && n > 0) ? new Date(n * 1000).toISOString() : null;
}

// deno-lint-ignore no-explicit-any
async function vpost(path: string, body: any): Promise<any> {
  const res = await fetch(VONIGO_BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify(body),
  });
  return vonigoJson(res);
}

async function vlogin(sb: ReturnType<typeof db>, franchiseUuid: string): Promise<string> {
  const { data: cred } = await sb.rpc('get_vonigo_credential', { p_franchise_id: franchiseUuid });
  const c = Array.isArray(cred) ? cred[0] : cred;
  if (!c?.vonigo_username || !c?.vonigo_md5) throw new Error('no_vonigo_credential');
  const u = new URL(VONIGO_BASE + '/security/login/');
  u.searchParams.set('company', 'Vonigo'); u.searchParams.set('userName', c.vonigo_username); u.searchParams.set('password', c.vonigo_md5);
  const res = await fetch(u.toString(), { headers: { 'User-Agent': UA } });
  const auth = await vonigoJson(res);
  if (auth.errNo !== 0 || !auth.securityToken) throw new Error('vonigo_auth_failed: ' + (auth.errMsg || auth.errNo));
  return auth.securityToken as string;
}

// Resolve a contact's phone (field 1088) + email (first @-bearing field). method 0 — method 1 returns empty.
async function resolveContact(tok: string, contactId: string): Promise<{ phone: string | null; email: string | null }> {
  if (!contactId) return { phone: null, email: null };
  try {
    // method 0 (search) — method 1 (single-retrieve) returns an EMPTY contact (0 fields), the false-negative
    // trap from the lead phone/email work. method 0 returns the populated Contacts array.
    const r = await vpost('/data/Contacts/', { securityToken: tok, method: '0', objectID: String(contactId), isCompleteObject: 'true' });
    const c = (r.Contacts && r.Contacts[0]) || r.Contact || {};
    let phone: string | null = null, email: string | null = null;
    for (const f of (c.Fields || [])) {
      const v = String(f.fieldValue || '');
      if (f.fieldID === F_CONTACT_PHONE && v) phone = v;
      if (!email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) email = v;
    }
    return { phone, email };
  } catch (_e) { return { phone: null, email: null }; }
}

async function syncCancels(sb: ReturnType<typeof db>, tok: string, franchiseUuid: string, tenantId: string | null, externalId: string, sinceDays: number) {
  const now = Math.floor(Date.now() / 1000);
  const dateStart = now - sinceDays * 86400;
  const dateEnd = now + 2 * 86400;             // include today + a small forward margin
  // 1) cancelled WorkOrders in-window
  const wos: Record<string, unknown>[] = [];
  for (let pg = 1; pg <= 40; pg++) {
    const r = await vpost('/data/WorkOrders/', {
      securityToken: tok, franchiseID: externalId, pageNo: String(pg), pageSize: '200', sortMode: '1', sortDirection: '1',
      isCompleteObject: 'true', dateMode: '3', dateStart: String(dateStart), dateEnd: String(dateEnd),
    });
    const arr = (r.WorkOrders || []) as Record<string, unknown>[];
    wos.push(...arr);
    if (arr.length < 200) break;
  }
  const cancels = wos.filter(w => CANCELLED.has(Number(fval(w, F_STATUS))));
  let scheduling = 0, upserted = 0, inserted = 0;
  const seenJob = new Set<string>();
  for (const w of cancels) {
    const jr = rel(w, 'job');
    const jobId = jr.objectID != null ? String(jr.objectID) : null;
    if (!jobId || seenJob.has(jobId)) continue;
    seenJob.add(jobId);
    // 2) the Job (method 0 — method 1 refuses a cancelled job) → cancel category 974
    const jr2 = await vpost('/data/Jobs/', { securityToken: tok, method: '0', jobID: jobId, pageSize: '1', isCompleteObject: 'true' });
    const job = (jr2.Job && jr2.Job[0]) || {};
    if (Number(fval(job, F_CANCEL_CAT)) !== SCHEDULING_CAT) continue;   // scheduling-reason only
    scheduling++;
    // 3) contact phone/email
    const contactId = rel(w, 'contact').objectID != null ? String(rel(w, 'contact').objectID) : '';
    const { phone, email } = await resolveContact(tok, contactId);
    const clientName = rel(w, 'client').name || ftext(w, F_CLIENT) || null;
    const reason = ftext(job, F_CANCEL_REASON);
    const comments = ftext(job, F_CANCEL_COMMENTS);
    const address = ftext(w, F_ADDRESS) || '';
    const town = (address.split('\n').pop() || '').replace(/\s+\d{5}.*$/, '').split(',')[0]?.trim() || null;
    const row = {
      franchise_id: franchiseUuid, tenant_id: tenantId, kind: 'cancel',
      source_type: 'job', source_id: jobId,
      customer_name: clientName, phone, email, town,
      vonigo_created_at: epochToISO(fval(w, F_DATE_SERVICE)),   // the (cancelled) appointment's service date
      label: reason,
      detail: { woId: w.objectID, apptName: w.name, category: 'Scheduling', reason, comments, serviceDate: fval(w, F_DATE_SERVICE), address },
      synced_at: new Date().toISOString(),
    };
    // upsert; detect insert vs update to write a 'created' event only on first sight
    const { data: existing } = await sb.from('followups').select('id').eq('franchise_id', franchiseUuid).eq('kind', 'cancel').eq('source_id', jobId).maybeSingle();
    const { data: up, error } = await sb.from('followups').upsert(row, { onConflict: 'franchise_id,kind,source_id' }).select('id').maybeSingle();
    if (error) { console.error('[followups-sync] upsert failed', jobId, error.message); continue; }
    upserted++;
    if (!existing && up?.id) {
      inserted++;
      await sb.from('followup_events').insert({ followup_id: up.id, franchise_id: franchiseUuid, event_type: 'created', to_stage: 'new', actor: 'system', detail: 'scheduling-cancel synced from Vonigo' });
    }
  }
  return { scanned: cancels.length, scheduling, upserted, inserted };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const externalId = String(body.franchiseID || '').trim();
    const sinceDays = Number(body.sinceDays) > 0 ? Number(body.sinceDays) : 90;
    const kinds: string[] = Array.isArray(body.kinds) && body.kinds.length ? body.kinds : ['cancel'];
    if (!externalId) return json({ success: false, error: 'franchiseID required' }, 400);

    const sb = db();
    const { data: fr } = await sb.from('franchises').select('id, tenant_id').eq('external_id', externalId).maybeSingle();
    if (!fr?.id) return json({ success: false, error: 'franchise_not_found' }, 404);

    const tok = await vlogin(sb, fr.id);
    const results: Record<string, unknown> = {};
    if (kinds.includes('cancel')) results.cancel = await syncCancels(sb, tok, fr.id, fr.tenant_id, externalId, sinceDays);
    // (lead / unconverted_estimate / ucb / case — later phases)

    return json({ success: true, franchiseID: externalId, sinceDays, results });
  } catch (e) {
    if (e instanceof VonigoUnavailable) return json(VONIGO_DOWN_BODY, 503);
    console.error('[followups-sync] fatal:', (e as Error).message, (e as Error).stack);
    return json({ success: false, error: (e as Error).message || 'Internal error' }, 500);
  }
});
