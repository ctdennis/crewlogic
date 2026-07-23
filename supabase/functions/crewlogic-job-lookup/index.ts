// Supabase Edge Function: crewlogic-job-lookup (v1.0)
// Looks up a single Vonigo job by jobID and returns the client/contact/location
// IDs + display info needed to hydrate an estimate. Migrated from the n8n
// `crewlogic-job-lookup` webhook — same MD5 /security/login/ auth the other
// edge functions use (no Vonigo OAuth involved).
//
// Deploy: supabase functions deploy crewlogic-job-lookup
//
// Request body:
//   { jobID: string, franchiseID: string, email?: string }
//
// Response (success):
//   { success: true, jobID, clientID, contactID, locationID,
//     clientName, address, zip, clientEmail, clientPhone }
// Response (failure):
//   { success: false, error: string }
//
// Parity notes (from the n8n workflow this replaces):
//   - WorkOrders queried by jobID (pageSize 10), isCompleteObject=true.
//   - clientID/contactID/locationID come from Relations by semantic
//     relationType ('client' | 'contact' | 'location1'), NOT magic field IDs.
//   - clientName is the 'client' relation's name (fieldID 216 is the assignee,
//     not the customer).
//   - address = fieldID 184 (newlines → ", "); zip parsed via /\b[A-Z]{2}\s+(\d{5})\b/.
//   - email = Contact fieldID 97; phone = Contact fieldID 1088.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { vonigoJson, VonigoUnavailable, VONIGO_DOWN_BODY } from '../_shared/vonigo.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TENANT_ID = '946a4535-aa61-45b6-a6fb-9190ff546d41'; // Junkluggers
const VONIGO_BASE = 'https://junkluggers.vonigo.com/api/v1';

// fieldIDs
const F_ADDRESS = 184;        // WorkOrder service address (multi-line)
const F_CONTACT_EMAIL = 97;   // Contact email
const F_CONTACT_PHONE = 1088; // Contact phone

interface VonigoField { fieldID: number; fieldValue: string | null; optionID: number; }
interface VonigoRelation { objectTypeID: number; objectID: string | number; name: string; relationType: string; isActive: boolean; }
interface VonigoWorkOrder { objectID: string; Fields: VonigoField[]; Relations: VonigoRelation[]; }
interface VonigoContact { objectID: string; Fields: VonigoField[]; }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return jsonResponse({ success: false, error: 'Method not allowed' }, 405);

  const reqId = crypto.randomUUID().slice(0, 8);

  try {
    const body = await req.json();
    const jobID = String(body.jobID || '').trim();
    const franchiseID = String(body.franchiseID || '').trim();

    if (!jobID) return jsonResponse({ success: false, error: 'jobID required', reqId }, 400);
    if (!franchiseID) return jsonResponse({ success: false, error: 'franchiseID required', reqId }, 400);

    // 1) Resolve franchise + Vonigo credentials (same pattern as crewlogic-todays-workorders)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: franchiseRow, error: franchiseErr } = await supabase
      .from('franchises')
      .select('id')
      .eq('external_id', franchiseID)
      .eq('tenant_id', TENANT_ID)
      .single();

    if (franchiseErr || !franchiseRow) {
      return jsonResponse({ success: false, error: 'Franchise not found: ' + franchiseID, reqId }, 404);
    }

    let creds: { vonigo_username: string; vonigo_md5: string } | null = null;
    const { data: credRows, error: credErr } = await supabase
      .rpc('get_vonigo_credential', { franchise_id_param: franchiseRow.id });
    if (!credErr && credRows && credRows.length > 0) {
      creds = credRows[0];
    } else {
      for (const paramName of ['p_franchise_id', 'franchise_id', 'franchiseid', 'fid']) {
        const args: Record<string, string> = {};
        args[paramName] = franchiseRow.id;
        const r = await supabase.rpc('get_vonigo_credential', args);
        if (!r.error && r.data && r.data.length > 0) { creds = r.data[0]; break; }
      }
    }
    if (!creds) {
      const { data: directRows } = await supabase
        .from('vonigo_credentials')
        .select('vonigo_username, vonigo_md5')
        .eq('franchise_id', franchiseRow.id)
        .limit(1);
      if (directRows && directRows.length > 0) creds = directRows[0];
    }
    if (!creds) {
      return jsonResponse({ success: false, error: 'Vonigo credentials not found for franchise ' + franchiseID, reqId }, 404);
    }

    // 2) Authenticate with Vonigo (MD5 login)
    const authUrl = new URL(VONIGO_BASE + '/security/login/');
    authUrl.searchParams.set('company', 'Vonigo');
    authUrl.searchParams.set('userName', creds.vonigo_username);
    authUrl.searchParams.set('password', creds.vonigo_md5);
    const authData = await vonigoJson(await fetch(authUrl.toString()));
    if (authData.errNo !== 0 || !authData.securityToken) {
      console.error(`[job-lookup][${reqId}] Vonigo auth failed: ${authData.errMsg || 'no token'}`);
      return jsonResponse({ success: false, error: 'Vonigo auth failed', reqId }, 502);
    }
    const securityToken = authData.securityToken;

    // 3) Query the WorkOrder by jobID
    const woData = await vonigoJson(await fetch(VONIGO_BASE + '/data/WorkOrders/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        securityToken,
        jobID,
        pageNo: '1',
        pageSize: '10',
        sortMode: '1',
        sortDirection: '1',
        isCompleteObject: 'true',
      }),
    }));

    // Match the n8n behavior: any non-result — Vonigo validation error (e.g. an
    // invalid/nonexistent job number → errNo -600), an error code, or an empty
    // list — is surfaced to the user as a friendly "Job not found". Genuine
    // Vonigo errNo values are logged server-side for diagnosis.
    const workOrder: VonigoWorkOrder | undefined = (woData.WorkOrders || [])[0];
    if (!workOrder) {
      if (woData.errNo !== 0) {
        console.warn(`[job-lookup][${reqId}] Vonigo errNo ${woData.errNo}: ${woData.errMsg || ''} (jobID ${jobID}) — treating as not found`);
      }
      return jsonResponse({ success: false, error: 'Job not found', reqId }, 200);
    }

    const relations = workOrder.Relations || [];
    const fields = workOrder.Fields || [];
    const rel = (type: string) => relations.find((r) => r.relationType === type);

    const clientRel = rel('client');
    const clientID = clientRel ? String(clientRel.objectID) : null;
    const contactRel = rel('contact');
    const locationRel = rel('location1');
    const clientName = clientRel?.name || '';

    if (!clientID) {
      return jsonResponse({ success: false, error: 'Could not find client on this job', reqId }, 200);
    }

    const rawAddress = (fields.find((f) => f.fieldID === F_ADDRESS)?.fieldValue) || '';
    let address = '';
    let zip = '';
    if (rawAddress) {
      address = rawAddress.replace(/\n/g, ', ').trim();
      const zipMatch = rawAddress.match(/\b[A-Z]{2}\s+(\d{5})\b/);
      if (zipMatch) zip = zipMatch[1];
    }

    // 4) Look up the client's contact for email/phone (best-effort)
    let clientEmail = '';
    let clientPhone = '';
    try {
      const contactData = await (await fetch(VONIGO_BASE + '/data/Contacts/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          securityToken,
          clientID,
          sortMode: '1',
          sortDirection: '0',
          pageNo: '1',
          pageSize: '50',
          isCompleteObject: 'true',
        }),
      })).json();
      const contact: VonigoContact | undefined = (contactData.Contacts || [])[0];
      const cFields = contact?.Fields || [];
      clientEmail = cFields.find((f) => f.fieldID === F_CONTACT_EMAIL)?.fieldValue || '';
      clientPhone = cFields.find((f) => f.fieldID === F_CONTACT_PHONE)?.fieldValue || '';
    } catch (e) {
      console.warn(`[job-lookup][${reqId}] contact lookup failed (non-fatal): ${(e as Error).message}`);
    }

    return jsonResponse({
      success: true,
      jobID,
      clientID,
      contactID: contactRel ? String(contactRel.objectID) : null,
      locationID: locationRel ? String(locationRel.objectID) : null,
      clientName,
      address,
      zip,
      clientEmail,
      clientPhone,
    });

  } catch (e) {
    // Vonigo down (Cloudflare 522 / HTML) → clean message instead of the raw "Unexpected token '<'".
    if (e instanceof VonigoUnavailable) {
      console.error(`[job-lookup][${reqId}] Vonigo unavailable (non-JSON response)`);
      return jsonResponse({ ...VONIGO_DOWN_BODY, reqId }, 503);
    }
    const err = e as Error;
    console.error(`[job-lookup][${reqId}] error:`, err?.stack || err?.message || err);
    return jsonResponse({ success: false, error: err.message || String(err), reqId }, 500);
  }
});
