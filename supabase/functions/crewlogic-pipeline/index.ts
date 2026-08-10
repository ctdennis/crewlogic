// crewlogic-pipeline — Follow-up Pipeline (FW / task #28). P1: the Vonigo SYNC ADAPTER.
//
// action: 'sync' { franchiseID, days?=30 | dateStart,dateEnd, types?=[...] }
//   Pulls the 5 ops types from Vonigo for the window and upserts them into pipeline_items.
//   The upsert writes ONLY source-derived columns → the CRM fields (stage/assigned_to/next_action_at/
//   cadence/notes) are PRESERVED across re-syncs. Touches/cadence come in P2.
//
// Provider-agnostic by design: this file is the Vonigo adapter only. The store (pipeline_items /
// pipeline_touches), the follow-up engine, and the UI are reused for the native build — a future
// `native` adapter emits the same rows. Keep every Vonigo id/field/label INSIDE this adapter.
//
// Recognition recipes validated 2026-08-06/07 (memory vonigo-five-type-recognition).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { vonigoJson, VonigoUnavailable, VONIGO_DOWN_BODY } from '../_shared/vonigo.ts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const TENANT_ID = '946a4535-aa61-45b6-a6fb-9190ff546d41';
const VONIGO_BASE = 'https://junkluggers.vonigo.com/api/v1';

// Vonigo field / recognition constants (live ONLY here — never leak into pipeline_items or the UI).
const F = { woStatus: 181, woLabel: 201, woAddress: 184, woPrice: 813, woDate: 185, clientStage: 123, contactPhone: 1088, jobCancelCat: 974, jobCancelReason: 975, jobCancelComments: 973, caseNarr: 220, caseType: 219, casePhone: 228, caseEmail: 229 };
const CANCEL_STATUS = new Set([162, 163]);      // Cancelled / Cancelled-Today
const EST_LABELS = new Set([9996, 9973, 9993]); // Est-Completed-EstOnly / Est-Only / Lost
const UCB_ROUTE_ID = 2987;                       // "Pending - Other (URGENTCB)"
const ALL_TYPES = ['lead', 'unconverted_estimate', 'cancellation', 'ucb', 'case'];

type VField = { fieldID: number; fieldValue?: string; optionID?: number };
type VRel = { relationType: string; objectID?: number | string; name?: string };
const getField = (fields: VField[] | undefined, id: number) => (fields || []).find((f) => f.fieldID === id);
const rel = (rels: VRel[] | undefined, t: string) => (rels || []).find((r) => r.relationType === t);
const num = (v: unknown) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const iso = (epochSec: unknown) => { const n = parseInt(String(epochSec ?? '0'), 10); return n > 0 ? new Date(n * 1000).toISOString() : null; };
const emailish = (fields: VField[] | undefined) => (fields || []).map((f) => f.fieldValue || '').find((v) => /@/.test(v)) || null;
function naiveDayEpoch(y: number, m: number, d: number) { return Math.floor(Date.UTC(y, m - 1, d) / 1000); }

// bounded-concurrency map (avoid Vonigo overload on per-item enrichment calls)
async function mapPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx]); } catch { out[idx] = null as unknown as R; } }
  });
  await Promise.all(workers);
  return out;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function resolveCreds(supabase: ReturnType<typeof createClient>, franchiseInternalId: string) {
  const { data: credRows, error } = await supabase.rpc('get_vonigo_credential', { franchise_id_param: franchiseInternalId });
  if (!error && credRows && credRows.length > 0) return credRows[0];
  for (const p of ['p_franchise_id', 'franchise_id', 'franchiseid', 'fid']) {
    const args: Record<string, string> = {}; args[p] = franchiseInternalId;
    const r = await supabase.rpc('get_vonigo_credential', args);
    if (!r.error && r.data && r.data.length > 0) return r.data[0];
  }
  const { data: direct } = await supabase.from('vonigo_credentials').select('vonigo_username, vonigo_md5').eq('franchise_id', franchiseInternalId).limit(1);
  return direct && direct.length ? direct[0] : null;
}
async function vonigoLogin(username: string, md5: string): Promise<string> {
  const u = new URL(VONIGO_BASE + '/security/login/');
  u.searchParams.set('company', 'Vonigo'); u.searchParams.set('userName', username); u.searchParams.set('password', md5);
  const d = await vonigoJson(await fetch(u.toString()));
  if (d.errNo !== 0 || !d.securityToken) throw new Error('vonigo_auth_failed: ' + (d.errMsg || 'no token'));
  return d.securityToken;
}
async function vpost(path: string, body: Record<string, unknown>) {
  return await vonigoJson(await fetch(VONIGO_BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  const reqId = crypto.randomUUID().slice(0, 8);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    const franchiseID = String(body.franchiseID || '').trim();
    if (action !== 'sync') return json({ success: false, error: 'unknown action', reqId }, 400);
    if (!franchiseID) return json({ success: false, error: 'franchiseID required', reqId }, 400);
    const types: string[] = Array.isArray(body.types) && body.types.length ? body.types.map(String) : ALL_TYPES;
    const want = (t: string) => types.includes(t);

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: fr, error: fe } = await supabase.from('franchises').select('id').eq('external_id', franchiseID).eq('tenant_id', TENANT_ID).single();
    if (fe || !fr) return json({ success: false, error: 'Franchise not found: ' + franchiseID, reqId }, 404);
    const franchiseInternalID = (fr as { id: string }).id;
    const creds = await resolveCreds(supabase, franchiseInternalID);
    if (!creds) return json({ success: false, error: 'No Vonigo credentials for franchise ' + franchiseID, reqId }, 404);

    // window (naive-ET midnight epochs — Vonigo WO date convention)
    const days = Math.min(Math.max(parseInt(String(body.days || '30'), 10) || 30, 1), 120);
    const now = new Date();
    const dateEnd = /^\d+$/.test(String(body.dateEnd)) ? parseInt(String(body.dateEnd), 10)
      : naiveDayEpoch(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()) + 86400;
    const dateStart = /^\d+$/.test(String(body.dateStart)) ? parseInt(String(body.dateStart), 10) : dateEnd - (days + 1) * 86400;

    let token: string;
    try { token = await vonigoLogin(creds.vonigo_username, creds.vonigo_md5); }
    catch { return json(VONIGO_DOWN_BODY, 503); }

    const rows: Record<string, unknown>[] = [];
    const mk = (type: string, source_object: string, source_external_id: string, extra: Record<string, unknown>) => ({
      tenant_id: TENANT_ID, franchise_id: franchiseInternalID, type, source_provider: 'vonigo',
      source_object, source_external_id, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...extra,
    });

    // ---- A) WorkOrders window → cancellation / unconverted_estimate / ucb ----
    if (want('cancellation') || want('unconverted_estimate') || want('ucb')) {
      const wos: Record<string, unknown>[] = [];
      for (let pg = 1; pg <= 12; pg++) {
        const r = await vpost('/data/WorkOrders/', { securityToken: token, franchiseID, pageNo: String(pg), pageSize: '200', sortMode: '1', sortDirection: '1', isCompleteObject: 'true', dateMode: '3', dateStart: String(dateStart), dateEnd: String(dateEnd) });
        if (r.errNo !== 0) break;
        const page = (r.WorkOrders as Record<string, unknown>[]) || [];
        wos.push(...page);
        if (page.length < 200) break;
      }
      for (const wo of wos) {
        const fields = wo.Fields as VField[]; const rels = wo.Relations as VRel[];
        const status = getField(fields, F.woStatus)?.optionID || 0;
        const label = getField(fields, F.woLabel)?.optionID || 0;
        const routeId = Number(rel(rels, 'route')?.objectID || 0);
        const base = {
          customer_name: rel(rels, 'client')?.name || '',
          address: getField(fields, F.woAddress)?.fieldValue || '',
          amount: num(getField(fields, F.woPrice)?.fieldValue),
          occurred_at: iso(getField(fields, F.woDate)?.fieldValue),
          raw: wo,
        };
        // Precedence: cancelled status wins, then estimate label, then the URGENTCB route.
        if (CANCEL_STATUS.has(status) && want('cancellation')) {
          // reason (Job fields 974/975/973) is a P2 follow-up — the WO's job relation carries the job NUMBER,
          // and /data/Jobs returns a shallow Job (0 fields) by it; needs the internal Job objectID / correct search.
          rows.push(mk('cancellation', 'workorder', String(wo.objectID), base));
        } else if (EST_LABELS.has(label) && want('unconverted_estimate')) {
          rows.push(mk('unconverted_estimate', 'workorder', String(wo.objectID), { ...base, reason: getField(fields, F.woLabel)?.fieldValue || String(label) }));
        } else if (routeId === UCB_ROUTE_ID && want('ucb')) {
          rows.push(mk('ucb', 'workorder', String(wo.objectID), base));
        }
      }
    }

    // ---- B) Leads = Clients (created-date) with stage 123 == "Lead"; phone/email from the Contact ----
    if (want('lead')) {
      const leads: Record<string, unknown>[] = [];
      for (let pg = 1; pg <= 20; pg++) {
        const r = await vpost('/data/Clients/', { securityToken: token, franchiseID, method: '-1', dateMode: '1', dateStart: String(dateStart), dateEnd: String(dateEnd), pageNo: String(pg), pageSize: '50', isCompleteObject: 'true' });
        if (r.errNo !== 0) break;
        const page = (r.Clients as Record<string, unknown>[]) || [];
        for (const c of page) { if ((getField(c.Fields as VField[], F.clientStage)?.fieldValue || '') === 'Lead') leads.push(c); }
        if (page.length < 50) break;
      }
      await mapPool(leads, 5, async (c) => {
        const fields = c.Fields as VField[]; const rels = c.Relations as VRel[];
        let phone: string | null = null, email: string | null = null;
        const contactId = rel(rels, 'contact')?.objectID;
        if (contactId != null) {
          try {
            const cr = await vpost('/data/Contacts/', { securityToken: token, method: '0', objectID: String(contactId), isCompleteObject: 'true' });
            const ct = (cr.Contacts && cr.Contacts[0]) || null;
            if (ct) { const cf = ct.Fields as VField[]; phone = getField(cf, F.contactPhone)?.fieldValue || null; email = emailish(cf); }
          } catch { /* contact optional */ }
        }
        rows.push(mk('lead', 'client', String(c.objectID), {
          customer_name: String(c.name || ''), phone, email,
          address: (fields || []).map((f) => f.fieldValue).find((v) => /\d/.test(String(v)) && /,/.test(String(v))) || null,
          occurred_at: iso(c.dateCreated), raw: c,
        }));
      });
    }

    // ---- C) Cases = /data/Cases plural key (franchise's own) ----
    if (want('case')) {
      for (let pg = 1; pg <= 6; pg++) {
        const r = await vpost('/data/Cases/', { securityToken: token, franchiseID, sortMode: '1', sortDirection: '1', pageNo: String(pg), pageSize: '50', isCompleteObject: 'true' });
        if (r.errNo !== 0) break;
        const page = (r.Cases as Record<string, unknown>[]) || [];
        for (const cs of page) {
          const cf = cs.Fields as VField[];
          rows.push(mk('case', 'case', String(cs.objectID), {
            customer_name: rel(cs.Relations as VRel[], 'client')?.name || '',
            phone: getField(cf, F.casePhone)?.fieldValue || null,
            email: getField(cf, F.caseEmail)?.fieldValue || null,
            reason: getField(cf, F.caseType)?.fieldValue || null,
            detail: getField(cf, F.caseNarr)?.fieldValue || null,
            occurred_at: iso(cs.dateCreated), raw: cs,
          }));
        }
        if (page.length < 50) break;
      }
    }

    // ---- Upsert (merge-duplicates): only source-derived cols in the payload → CRM fields preserved. ----
    let upserted = 0;
    if (rows.length) {
      const { error } = await supabase.from('pipeline_items').upsert(rows, { onConflict: 'tenant_id,type,source_external_id' });
      if (error) { console.error(`[pipeline:${reqId}] upsert failed:`, error); return json({ success: false, error: 'Save failed', reqId }, 500); }
      upserted = rows.length;
    }
    const counts: Record<string, number> = {};
    for (const t of ALL_TYPES) counts[t] = rows.filter((r) => r.type === t).length;
    return json({ success: true, franchiseID, window: { dateStart, dateEnd, days }, upserted, counts, reqId });
  } catch (e) {
    if (e instanceof VonigoUnavailable) return json(VONIGO_DOWN_BODY, 503);
    console.error(`[pipeline:${reqId}] error:`, (e as Error)?.stack || String(e));
    return json({ success: false, error: 'Could not sync the pipeline.', reqId }, 500);
  }
});
