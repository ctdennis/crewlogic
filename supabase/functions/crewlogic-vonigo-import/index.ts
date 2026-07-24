// Supabase Edge Function: crewlogic-vonigo-import
//
// The Vonigo READ-ONLY adapter (FW-58 / docs/contract-vonigo-adapter.md). Pulls Vonigo WorkOrders
// for a franchise across a date window and mirrors them into the canonical job model so a franchise
// can find/route/collect through a Vonigo outage:
//   Vonigo Job (jobID)       -> public.jobs               (origin='import')
//   Vonigo WorkOrder (woID)  -> public.job_appointments   (the visit)
//   provider DR extras       -> public.job_source_snapshot (amount, crew names, customer, route, raw)
//   idempotency              -> public.external_refs (entity_type, provider='vonigo', external_id)
//
// Idempotent by design: every WO resolves its canonical row via external_refs, so re-runs UPDATE in
// place. Cancellations arrive as a status change on the same WO; reschedules rewrite the same
// appointment's date. Read-only against Vonigo — never writes back.
//
// Request (POST): { franchiseID: string, action?: 'backfill'|'sync', daysBack?, daysForward? }
//   backfill default window: 183 days back, 7 forward.  sync default: 14 back, 7 forward.
// Response: { success, franchiseID, window, counts: { workOrders, jobs, appointments, skipped, errors } }
//
// Deploy (DEV):
//   supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-vonigo-import --use-api --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveTimezoneLogged, franchiseDayEpoch } from '../_shared/tz.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const VONIGO_BASE = 'https://junkluggers.vonigo.com/api/v1';

// WorkOrder fieldIDs (objectTypeID WorkOrder) — same set crewlogic-todays-workorders reads.
const F_STATUS = 181, F_CONTACT = 183, F_ADDRESS = 184, F_DATE = 185, F_DURATION = 186;
const F_LABEL = 201, F_PRICE = 813, F_TIME_MIN = 9082, F_ITEMS = 10336, F_NOTES = 200;
// Customer phone/email live on the Vonigo CONTACT object (fetched by clientID via /data/Contacts/),
// NOT the WorkOrder — the same source crewlogic-job-lookup uses. Captured at IMPORT time so they
// survive an outage (a lazy lookup would fail exactly when the DR board is needed).
const F_CONTACT_EMAIL = 97, F_CONTACT_PHONE = 1088;

// Vonigo status optionIDs
const ST_CANCELLED = 162, ST_INPROGRESS = 163, ST_COMPLETED = 164, ST_ARCHIVED = 165;

interface VField { fieldID: number; fieldValue: string | null; optionID?: number }
interface VRelation { relationType: string; objectID: number | string; name?: string; isActive?: boolean }
interface VWorkOrder { objectID: number | string; Fields?: VField[]; Relations?: VRelation[] }

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function getField(fields: VField[], id: number): VField | undefined {
  return fields.find((f) => f.fieldID === id);
}
function str(v: unknown): string { return v == null ? '' : String(v).trim(); }

// Vonigo WorkOrder date fields are naive-Eastern (clock-as-UTC), so reading the epoch as UTC yields
// the intended calendar day. Correct for ET franchises; documented caveat for non-ET (like the
// getEasternMidnight note in crewlogic-todays-workorders) — first consumer #90 is ET.
function serviceDateFromEpoch(epoch: number): string | null {
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

function apptStatus(optID: number, label: string): string {
  if (optID === ST_CANCELLED || /cancel/i.test(label)) return 'cancelled';
  if (optID === ST_COMPLETED || optID === ST_ARCHIVED) return 'done';
  if (optID === ST_INPROGRESS) return 'working';
  return 'scheduled';
}
function isJobComplete(optID: number): boolean {
  return optID === ST_COMPLETED || optID === ST_ARCHIVED;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405);

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const franchiseID = str(body.franchiseID);
  if (!franchiseID) return json({ success: false, error: 'franchiseID required' }, 400);
  const action = str(body.action) === 'backfill' ? 'backfill' : 'sync';
  const daysBack = Number(body.daysBack) || (action === 'backfill' ? 183 : 14);
  const daysForward = Number(body.daysForward) || 7;

  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  const counts = { workOrders: 0, jobs: 0, appointments: 0, skipped: 0, errors: 0 };

  try {
    // 1) Franchise row (internal id + tz) + Vonigo creds.
    const { data: frRows, error: frErr } = await db
      .from('franchises').select('id, cost_settings').eq('external_id', franchiseID).limit(1);
    if (frErr) throw frErr;
    const fr = frRows && frRows[0];
    if (!fr) return json({ success: false, error: 'franchise not found: ' + franchiseID }, 404);
    const franchiseInternalID = fr.id as string;

    // Vonigo creds are Vault-encrypted — fetch via the RPC (same path as crewlogic-todays-workorders).
    let creds: { vonigo_username: string; vonigo_md5: string } | null = null;
    const primary = await db.rpc('get_vonigo_credential', { franchise_id_param: franchiseInternalID });
    if (!primary.error && primary.data && primary.data.length) creds = primary.data[0];
    else {
      for (const p of ['p_franchise_id', 'franchise_id', 'franchiseid', 'fid']) {
        const args: Record<string, string> = {}; args[p] = franchiseInternalID;
        const r = await db.rpc('get_vonigo_credential', args);
        if (!r.error && r.data && r.data.length) { creds = r.data[0]; break; }
      }
    }
    if (!creds) return json({ success: false, error: 'vonigo credentials not found for ' + franchiseID }, 404);

    // 2) Vonigo login.
    const authUrl = new URL(VONIGO_BASE + '/security/login/');
    authUrl.searchParams.set('company', 'Vonigo');
    authUrl.searchParams.set('userName', creds.vonigo_username);
    authUrl.searchParams.set('password', creds.vonigo_md5);
    const authData = await (await fetch(authUrl.toString())).json();
    if (authData.errNo !== 0 || !authData.securityToken) {
      return json({ success: false, error: 'vonigo auth failed: ' + (authData.errMsg || 'no token') }, 502);
    }
    const securityToken = authData.securityToken;

    // 3) Window in the franchise's zone (naive clock-face epoch — Vonigo convention).
    const tz = resolveTimezoneLogged(fr.cost_settings, `vonigo-import f=${franchiseID}`);
    // Explicit epoch window (dateStart/dateEnd) lets a caller month-chunk a big backfill; otherwise a
    // window around today from daysBack/daysForward.
    const dateStart = (body.dateStart != null) ? Number(body.dateStart) : franchiseDayEpoch(tz, -Math.abs(daysBack));
    const dateEnd = (body.dateEnd != null) ? Number(body.dateEnd) : franchiseDayEpoch(tz, Math.abs(daysForward) + 1);
    // Deep-history backfill sets skipContacts to skip the per-customer /data/Contacts/ fetch (fast; name
    // only, no phone/email) — old jobs don't need a callable number. Recent syncs keep it false.
    const skipContacts = body.skipContacts === true;
    const now = new Date().toISOString();

    // Per-invocation contact cache: one /data/Contacts/ fetch per unique clientID (best-effort).
    const contactCache = new Map<string, { phone: string; email: string }>();
    const fetchContact = async (clientID: string): Promise<{ phone: string; email: string }> => {
      if (contactCache.has(clientID)) return contactCache.get(clientID)!;
      let out = { phone: "", email: "" };
      try {
        const cd = await (await fetch(VONIGO_BASE + "/data/Contacts/", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ securityToken, clientID, sortMode: "1", sortDirection: "0", pageNo: "1", pageSize: "50", isCompleteObject: "true" }),
        })).json();
        const cf: VField[] = ((cd.Contacts || [])[0]?.Fields) || [];
        const email = str(cf.find((f) => f.fieldID === F_CONTACT_EMAIL)?.fieldValue);
        out = {
          phone: str(cf.find((f) => f.fieldID === F_CONTACT_PHONE)?.fieldValue),
          email: /noemail/i.test(email) ? "" : email,   // Vonigo's "noemail@noemail.com" placeholder = no email
        };
      } catch (e) {
        console.error("[vonigo-import] contact fetch failed (client " + clientID + "):", (e as Error).message);
      }
      contactCache.set(clientID, out);
      return out;
    };

    // 4) Pull ALL WorkOrders across the window (paginated) into memory.
    const PAGE = 200;
    const allWOs: VWorkOrder[] = [];
    for (let pageNo = 1; pageNo <= 500; pageNo++) {
      const woRes = await fetch(VONIGO_BASE + '/data/WorkOrders/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          securityToken, franchiseID, pageNo: String(pageNo), pageSize: String(PAGE),
          sortMode: '1', sortDirection: '1', isCompleteObject: 'true',
          dateMode: '3', dateStart: String(dateStart), dateEnd: String(dateEnd),
        }),
      });
      const woData = await woRes.json();
      if (woData.errNo !== 0) throw new Error('vonigo WorkOrders failed: ' + (woData.errMsg || 'errNo ' + woData.errNo));
      const workOrders: VWorkOrder[] = woData.WorkOrders || [];
      if (!workOrders.length) break;
      for (const w of workOrders) allWOs.push(w);
      if (workOrders.length < PAGE) break;
    }

    // Pre-fetch every unique customer's contact IN PARALLEL (batched) so the per-customer /data/Contacts/
    // calls don't serialize into the 150s function limit on busy franchises. Populates contactCache; the
    // loop below reads from it. Skipped for deep-history (skipContacts) — those rows are name-only.
    if (!skipContacts) {
      const clientIDs = [...new Set(allWOs.map((w) => {
        const cr = (w.Relations || []).find((r) => r.relationType === 'client');
        return cr?.objectID ? String(cr.objectID) : '';
      }).filter(Boolean))];
      const CBATCH = 12;
      for (let i = 0; i < clientIDs.length; i += CBATCH) {
        await Promise.all(clientIDs.slice(i, i + CBATCH).map((cid) => fetchContact(cid)));
      }
    }

    // ── BATCHED WRITE PATH ──────────────────────────────────────────────────────────────────
    // Parse each valid WO into a record, then BULK-UPSERT jobs → appointments → snapshots keyed on
    // source_external_id (the provider id, unique per franchise; migration 0070). This turns thousands
    // of round-trips into ~10, so busy franchises (Kevin/Queens+LI, NYC-scale) fit the 150s limit.
    // external_refs is no longer maintained here — source_external_id is the mirror's identity key.
    interface Rec {
      jobID: string; woID: string; serviceDate: string; startMin: number | null; durationMin: number | null;
      status: string; jobComplete: boolean; address: string; items: string; notes: string; price: number | null;
      crew: { id: unknown; name: string }[]; routeName: string; custName: string; phone: string; email: string; raw: VWorkOrder;
    }
    const recs: Rec[] = [];
    for (const wo of allWOs) {
      counts.workOrders++;
      const fields = wo.Fields || [];
      const relations = wo.Relations || [];
      const jobRel = relations.find((r) => r.relationType === 'job');
      const clientRel = relations.find((r) => r.relationType === 'client');
      const routeRel = relations.find((r) => r.relationType === 'route');
      const crew = relations.filter((r) => r.relationType === 'crew').map((c) => ({ id: c.objectID, name: c.name || '' }));
      const jobID = jobRel?.objectID ? String(jobRel.objectID) : '';
      const woID = String(wo.objectID);
      const serviceEpoch = parseInt(str(getField(fields, F_DATE)?.fieldValue) || '0', 10);
      const serviceDate = serviceDateFromEpoch(serviceEpoch);
      if (!jobID || !serviceDate) { counts.skipped++; continue; }
      const statusOptID = getField(fields, F_STATUS)?.optionID || 0;
      const statusLabel = str(getField(fields, F_STATUS)?.fieldValue);
      const clientID = clientRel?.objectID ? String(clientRel.objectID) : '';
      const ci = (clientID && !skipContacts) ? (contactCache.get(clientID) || { phone: '', email: '' }) : { phone: '', email: '' };
      const startMin = parseInt(str(getField(fields, F_TIME_MIN)?.fieldValue) || '', 10);
      const durationMin = parseInt(str(getField(fields, F_DURATION)?.fieldValue) || '', 10);
      recs.push({
        jobID, woID, serviceDate,
        startMin: Number.isFinite(startMin) ? startMin : null,
        durationMin: (Number.isFinite(durationMin) && durationMin > 0) ? durationMin : null,
        status: apptStatus(statusOptID, statusLabel),
        jobComplete: isJobComplete(statusOptID),
        address: str(getField(fields, F_ADDRESS)?.fieldValue),
        items: str(getField(fields, F_ITEMS)?.fieldValue),
        notes: str(getField(fields, F_NOTES)?.fieldValue),
        price: parseFloat(str(getField(fields, F_PRICE)?.fieldValue) || '') || null,
        crew, routeName: routeRel?.name || '',
        custName: clientRel?.name || str(getField(fields, F_CONTACT)?.fieldValue) || '',
        phone: ci.phone, email: ci.email, raw: wo,
      });
    }

    const chunk = <T>(arr: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
    const CHUNK = 500;

    // JOBS — dedupe by jobID; a job is 'completed' only if EVERY WorkOrder under it is complete.
    const jobAgg = new Map<string, { address: string; items: string; notes: string; allComplete: boolean }>();
    for (const r of recs) {
      const j = jobAgg.get(r.jobID);
      if (!j) jobAgg.set(r.jobID, { address: r.address, items: r.items, notes: r.notes, allComplete: r.jobComplete });
      else { j.allComplete = j.allComplete && r.jobComplete; if (!j.address && r.address) j.address = r.address; }
    }
    const jobRows = [...jobAgg.entries()].map(([jobID, j]) => ({
      franchise_id: franchiseInternalID, source_external_id: jobID, job_number: jobID, origin: 'import',
      status: j.allComplete ? 'completed' : 'scheduled',
      service_address: j.address || '(no address)', items_description: j.items || null, notes_internal: j.notes || null,
    }));
    const jobUuid = new Map<string, string>();
    for (const c of chunk(jobRows, CHUNK)) {
      const { data, error } = await db.from('jobs').upsert(c, { onConflict: 'franchise_id,source_external_id' }).select('id, source_external_id');
      if (error) throw error;
      for (const row of (data || [])) jobUuid.set(String(row.source_external_id), String(row.id));
      counts.jobs += c.length;
    }

    // APPOINTMENTS — one per woID.
    const apptRows = recs.map((r) => ({
      franchise_id: franchiseInternalID, source_external_id: r.woID, job_id: jobUuid.get(r.jobID),
      scheduled_date: r.serviceDate, start_minutes: r.startMin, duration_minutes: r.durationMin, status: r.status,
    })).filter((a) => a.job_id);
    const apptUuid = new Map<string, string>();
    for (const c of chunk(apptRows, CHUNK)) {
      const { data, error } = await db.from('job_appointments').upsert(c, { onConflict: 'franchise_id,source_external_id' }).select('id, source_external_id');
      if (error) throw error;
      for (const row of (data || [])) apptUuid.set(String(row.source_external_id), String(row.id));
      counts.appointments += c.length;
    }

    // SNAPSHOTS — provider DR extras, keyed on appointment_id.
    const snapRows = recs.map((r) => {
      const apptId = apptUuid.get(r.woID);
      if (!apptId) return null;
      return {
        appointment_id: apptId, franchise_id: franchiseInternalID, provider: 'vonigo',
        import_total: r.price, crew_display: r.crew.length ? r.crew : null,
        customer_display: { name: r.custName || null, phone: r.phone || null, email: r.email || null },
        route_name: r.routeName || null, raw: r.raw, synced_at: now,
      };
    }).filter(Boolean) as Record<string, unknown>[];
    for (const c of chunk(snapRows, CHUNK)) {
      const { error } = await db.from('job_source_snapshot').upsert(c, { onConflict: 'appointment_id' });
      if (error) throw error;
    }

    return json({ success: true, franchiseID, action, window: { dateStart, dateEnd }, counts });
  } catch (e) {
    // Full error to the server log (never suppress); client body stays generic (internal admin fn).
    console.error('[vonigo-import] fatal:', (e as Error).message);
    return json({ success: false, error: 'import failed', counts }, 500);
  }
});
