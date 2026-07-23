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
const F_PHONE = 10288;  // contact phone on the WorkOrder (verified from raw payloads 2026-07-23). Email
                        // is NOT on the WO (it lives on the Vonigo client record) — a follow-up lookup.

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
    const dateStart = franchiseDayEpoch(tz, -Math.abs(daysBack));
    const dateEnd = franchiseDayEpoch(tz, Math.abs(daysForward) + 1);
    const now = new Date().toISOString();

    // 4) Paginate WorkOrders across the window and mirror each.
    const PAGE = 200;
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

      for (const wo of workOrders) {
        counts.workOrders++;
        try {
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
          // Need a job to group under and a schedulable date (appointment date is NOT NULL).
          if (!jobID || !serviceDate) { counts.skipped++; continue; }

          const statusOptID = getField(fields, F_STATUS)?.optionID || 0;
          const statusLabel = str(getField(fields, F_STATUS)?.fieldValue);
          const address = str(getField(fields, F_ADDRESS)?.fieldValue);
          const items = str(getField(fields, F_ITEMS)?.fieldValue);
          const notes = str(getField(fields, F_NOTES)?.fieldValue);
          const contactName = str(getField(fields, F_CONTACT)?.fieldValue);
          const phone = str(getField(fields, F_PHONE)?.fieldValue);
          const startMin = parseInt(str(getField(fields, F_TIME_MIN)?.fieldValue) || '', 10);
          const durationMin = parseInt(str(getField(fields, F_DURATION)?.fieldValue) || '', 10);
          const price = parseFloat(str(getField(fields, F_PRICE)?.fieldValue) || '') || null;

          // ── JOB (upsert via external_refs) ──
          const jobRef = await db.from('external_refs')
            .select('crewlogic_id').eq('entity_type', 'job').eq('provider', 'vonigo').eq('external_id', jobID).limit(1);
          let jobUuid = jobRef.data && jobRef.data[0]?.crewlogic_id as string | undefined;
          const jobBase: Record<string, unknown> = {
            service_address: address || '(no address)',
            items_description: items || null,
            notes_internal: notes || null,
          };
          if (isJobComplete(statusOptID)) jobBase.status = 'completed';
          if (jobUuid) {
            const upd = await db.from('jobs').update(jobBase).eq('id', jobUuid);
            if (upd.error) throw upd.error;
          } else {
            const ins = await db.from('jobs').insert({
              franchise_id: franchiseInternalID, job_number: jobID, origin: 'import',
              status: isJobComplete(statusOptID) ? 'completed' : 'scheduled', ...jobBase,
            }).select('id').single();
            if (ins.error) throw ins.error;
            jobUuid = ins.data.id as string;
            counts.jobs++;
            const rref = await db.from('external_refs').upsert(
              { entity_type: 'job', crewlogic_id: jobUuid, franchise_id: franchiseInternalID, provider: 'vonigo', external_id: jobID, last_synced_at: now },
              { onConflict: 'entity_type,provider,external_id' });
            if (rref.error) throw rref.error;
          }

          // ── APPOINTMENT (upsert via external_refs) ──
          const apRef = await db.from('external_refs')
            .select('crewlogic_id').eq('entity_type', 'appointment').eq('provider', 'vonigo').eq('external_id', woID).limit(1);
          let apUuid = apRef.data && apRef.data[0]?.crewlogic_id as string | undefined;
          const apBase: Record<string, unknown> = {
            job_id: jobUuid, franchise_id: franchiseInternalID,
            scheduled_date: serviceDate,
            start_minutes: Number.isFinite(startMin) ? startMin : null,
            duration_minutes: Number.isFinite(durationMin) && durationMin > 0 ? durationMin : null,
            status: apptStatus(statusOptID, statusLabel),
          };
          if (apUuid) {
            const upd = await db.from('job_appointments').update(apBase).eq('id', apUuid);
            if (upd.error) throw upd.error;
          } else {
            const ins = await db.from('job_appointments').insert(apBase).select('id').single();
            if (ins.error) throw ins.error;
            apUuid = ins.data.id as string;
            counts.appointments++;
            const rref = await db.from('external_refs').upsert(
              { entity_type: 'appointment', crewlogic_id: apUuid, franchise_id: franchiseInternalID, provider: 'vonigo', external_id: woID, last_synced_at: now },
              { onConflict: 'entity_type,provider,external_id' });
            if (rref.error) throw rref.error;
          }

          // ── SNAPSHOT (provider DR extras) ──
          const snap = await db.from('job_source_snapshot').upsert({
            appointment_id: apUuid, franchise_id: franchiseInternalID, provider: 'vonigo',
            import_total: price,
            crew_display: crew.length ? crew : null,
            customer_display: { name: clientRel?.name || contactName || null, phone: phone || null, email: null },
            route_name: routeRel?.name || null,
            raw: wo, synced_at: now,
          }, { onConflict: 'appointment_id' });
          if (snap.error) throw snap.error;

          // Keep external_refs.last_synced_at fresh on already-known rows too.
          await db.from('external_refs').update({ last_synced_at: now })
            .eq('provider', 'vonigo').in('entity_type', ['job', 'appointment'])
            .in('external_id', [jobID, woID]);
        } catch (e) {
          counts.errors++;
          console.error('[vonigo-import] WO ' + String(wo.objectID) + ' failed:', (e as Error).message);
        }
      }
      if (workOrders.length < PAGE) break;
    }

    return json({ success: true, franchiseID, action, window: { dateStart, dateEnd }, counts });
  } catch (e) {
    // Full error to the server log (never suppress); client body stays generic (internal admin fn).
    console.error('[vonigo-import] fatal:', (e as Error).message);
    return json({ success: false, error: 'import failed', counts }, 500);
  }
});
