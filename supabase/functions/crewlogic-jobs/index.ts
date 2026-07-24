// Supabase Edge Function: crewlogic-jobs (read-only) — FW-58 / docs/contract-vonigo-adapter.md §6
//
// The franchise-scoped READ path over the canonical job model, for the Backup Schedule (DR) board.
//
//   action 'list' — appointments in a date range (the board): { franchiseInternalID, dateFrom, dateTo, status? }
//   action 'get'  — one job + its appointments:                { franchiseInternalID, jobId }
//
// AUTH MODEL — matches the rest of the app (crewlogic-settings / crewlogic-todays-workorders): the app
// authenticates most users (Google) with a CUSTOM session that has no Supabase Auth JWT, so it calls
// edge functions with the anon key and passes the franchise it already resolved at login. This function
// therefore uses the SERVICE role and scopes every query by the caller-supplied franchiseInternalID.
// (SEC follow-up, app-wide: verify the franchise server-side once the auth model is unified — same open
// item as crewlogic-settings/-todays-workorders, which trust the client franchiseID today.)
//
// notes_internal (confidential, Vonigo field 200) is intentionally NOT returned.
//
// Deploy: supabase functions deploy <ref> crewlogic-jobs --use-api --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function str(v: unknown): string { return v == null ? '' : String(v).trim(); }

// Vonigo up/down state for the DR board banner (service_health is service-role only).
async function vonigoHealth(db: ReturnType<typeof createClient>): Promise<Record<string, unknown> | null> {
  try {
    const { data } = await db.from('service_health').select('is_up, last_checked, last_changed').eq('service', 'vonigo').limit(1);
    const row = data && data[0];
    return row ? { isUp: row.is_up, lastChecked: row.last_checked, lastChanged: row.last_changed } : null;
  } catch { return null; }
}

// Appointment + its job + provider snapshot.
const APPT_SELECT =
  'id, scheduled_date, start_minutes, duration_minutes, status, ' +
  'job:jobs!inner ( id, job_number, status, origin, service_address, service_city, service_state, service_zip, service_lat, service_lng, items_description ), ' +
  'snapshot:job_source_snapshot ( import_total, crew_display, customer_display, route_name, synced_at )';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405);

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = str(body.action) || 'list';
  const franchiseInternalID = str(body.franchiseInternalID);
  if (!franchiseInternalID) return json({ success: false, error: 'franchiseInternalID required' }, 400);

  const db = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    if (action === 'list') {
      const dateFrom = str(body.dateFrom);
      const dateTo = str(body.dateTo);
      if (!dateFrom || !dateTo) return json({ success: false, error: 'dateFrom and dateTo required (YYYY-MM-DD)' }, 400);
      // Cap the payload; keep the MOST RECENT rows (order desc) so older jobs are reached by narrowing
      // to an earlier window. The client re-groups by day for display, so on-screen order is unchanged.
      const LIMIT = 500;
      let q = db.from('job_appointments').select(APPT_SELECT)
        .eq('franchise_id', franchiseInternalID)
        .gte('scheduled_date', dateFrom).lte('scheduled_date', dateTo)
        .order('scheduled_date', { ascending: false })
        .limit(LIMIT + 1);
      const statuses = Array.isArray(body.status) ? (body.status as unknown[]).map(String) : null;
      if (statuses && statuses.length) q = q.in('status', statuses);
      const { data, error } = await q;
      if (error) throw error;
      // Overall date bounds for this franchise, so the client can constrain the From/To pickers to the
      // range that actually has data.
      const [lo, hi] = await Promise.all([
        db.from('job_appointments').select('scheduled_date').eq('franchise_id', franchiseInternalID).not('scheduled_date', 'is', null).order('scheduled_date', { ascending: true }).limit(1),
        db.from('job_appointments').select('scheduled_date').eq('franchise_id', franchiseInternalID).not('scheduled_date', 'is', null).order('scheduled_date', { ascending: false }).limit(1),
      ]);
      const bounds = { min: (lo.data && lo.data[0]?.scheduled_date) || null, max: (hi.data && hi.data[0]?.scheduled_date) || null };
      const rows = data || [];
      const truncated = rows.length > LIMIT;
      return json({ success: true, appointments: shape(truncated ? rows.slice(0, LIMIT) : rows), truncated, bounds, health: await vonigoHealth(db) });
    }

    if (action === 'get') {
      const jobId = str(body.jobId);
      if (!jobId) return json({ success: false, error: 'jobId required' }, 400);
      const { data: jobRows, error: jErr } = await db.from('jobs')
        .select('id, job_number, status, origin, service_address, service_city, service_state, service_zip, service_lat, service_lng, items_description')
        .eq('id', jobId).eq('franchise_id', franchiseInternalID).limit(1);
      if (jErr) throw jErr;
      if (!jobRows || !jobRows.length) return json({ success: false, error: 'job_not_found' }, 404);
      const { data: appts, error: aErr } = await db.from('job_appointments').select(APPT_SELECT)
        .eq('franchise_id', franchiseInternalID).eq('job_id', jobId).order('scheduled_date', { ascending: true });
      if (aErr) throw aErr;
      return json({ success: true, job: jobRows[0], appointments: shape(appts || []) });
    }

    return json({ success: false, error: 'unknown action' }, 400);
  } catch (e) {
    console.error('[crewlogic-jobs] error:', (e as Error).message);
    return json({ success: false, error: 'read_failed' }, 500);
  }
});

// PostgREST returns the to-one snapshot embed as an object or a 1-element array; normalize to a single object.
function shape(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const snap = r.snapshot;
    return { ...r, snapshot: Array.isArray(snap) ? (snap[0] ?? null) : (snap ?? null) };
  });
}
