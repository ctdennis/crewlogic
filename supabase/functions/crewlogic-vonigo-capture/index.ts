// Supabase Edge Function: crewlogic-vonigo-capture (diagnostic, read-only)
//
// Captures the RAW Vonigo Job object AND its WorkOrder object(s) for a given jobID, so a before/after
// diff around a manual change shows exactly which field/relation flips — on either endpoint. Used to
// discover the right flag to set (same technique as the crew / mark-complete investigations).
//
// Request (POST): { franchiseID: string, jobID: string }
// Response: { success, job: <raw /data/Jobs/ response>, workOrders: <raw /data/WorkOrders/ response> }
//
// Read-only against Vonigo. Deploy: supabase functions deploy <ref> crewlogic-vonigo-capture --use-api --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const VONIGO_BASE = 'https://junkluggers.vonigo.com/api/v1';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405);

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const franchiseID = String(body.franchiseID || '').trim();
  const jobID = String(body.jobID || '').trim();
  if (!franchiseID || !jobID) return json({ success: false, error: 'franchiseID and jobID required' }, 400);

  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  try {
    const { data: frRows } = await db.from('franchises').select('id').eq('external_id', franchiseID).limit(1);
    const fr = frRows && frRows[0];
    if (!fr) return json({ success: false, error: 'franchise not found' }, 404);

    // Vonigo creds via the shared RPC (Vault), then MD5 login.
    let creds: { vonigo_username: string; vonigo_md5: string } | null = null;
    const primary = await db.rpc('get_vonigo_credential', { franchise_id_param: fr.id });
    if (!primary.error && primary.data && primary.data.length) creds = primary.data[0];
    else {
      for (const p of ['p_franchise_id', 'franchise_id', 'franchiseid', 'fid']) {
        const args: Record<string, string> = {}; args[p] = fr.id as string;
        const r = await db.rpc('get_vonigo_credential', args);
        if (!r.error && r.data && r.data.length) { creds = r.data[0]; break; }
      }
    }
    if (!creds) return json({ success: false, error: 'vonigo credentials not found' }, 404);

    const authUrl = new URL(VONIGO_BASE + '/security/login/');
    authUrl.searchParams.set('company', 'Vonigo');
    authUrl.searchParams.set('userName', creds.vonigo_username);
    authUrl.searchParams.set('password', creds.vonigo_md5);
    const authData = await (await fetch(authUrl.toString())).json();
    if (authData.errNo !== 0 || !authData.securityToken) return json({ success: false, error: 'vonigo auth failed' }, 502);
    const securityToken = authData.securityToken;

    // WorkOrder(s) for this job.
    const workOrders = await (await fetch(VONIGO_BASE + '/data/WorkOrders/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ securityToken, jobID, pageNo: '1', pageSize: '20', isCompleteObject: 'true' }),
    })).json();

    // The Job object itself (returns under key "Job").
    const job = await (await fetch(VONIGO_BASE + '/data/Jobs/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ securityToken, objectID: jobID, isCompleteObject: 'true' }),
    })).json();

    // Quotes for this job. Try a jobID filter and an objectID retrieval so we can see which Vonigo answers.
    const quotesByJob = await (await fetch(VONIGO_BASE + '/data/Quotes/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ securityToken, jobID, pageNo: '1', pageSize: '20', isCompleteObject: 'true' }),
    })).json();
    const quotesByObjectID = await (await fetch(VONIGO_BASE + '/data/Quotes/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ securityToken, objectID: jobID, isCompleteObject: 'true' }),
    })).json();

    // Field 201 (appointment label) options — the authoritative optionID → name (and any color) map.
    const labelOptions = await (await fetch(VONIGO_BASE + '/system/objects/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ securityToken, method: '1', fieldID: '201' }),
    })).json();

    return json({ success: true, jobID, franchiseID, job, workOrders, quotes: { byJob: quotesByJob, byObjectID: quotesByObjectID }, labelOptions });
  } catch (e) {
    console.error('[vonigo-capture] error:', (e as Error).message);
    return json({ success: false, error: 'capture failed', detail: (e as Error).message }, 500);
  }
});
