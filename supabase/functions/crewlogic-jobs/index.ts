// Supabase Edge Function: crewlogic-jobs (read-only slice) — FW-58 / docs/contract-vonigo-adapter.md §6
//
// The franchise-scoped READ path over the canonical job model. v1 ships only the read actions the DR
// board needs; native authoring (create/update/transition/cancel) is a separate contract.
//
//   action 'list' — appointments in a date range (the board): { dateFrom, dateTo, status? }
//   action 'get'  — one job + its appointments:               { jobId }
//
// AUTH: this is customer data. The function runs queries with the CALLER'S JWT, so Row-Level Security
// (franchise_id = current_franchise_id()) scopes every row to the caller's own franchise — a user can
// never read another franchise's jobs. Anonymous callers get 401. The client must send the user's
// access_token (supabaseClient.auth.getSession().access_token) as the Bearer token, NOT the anon key.
//
// notes_internal (confidential, Vonigo field 200) is intentionally NOT returned in v1.
//
// Deploy (DEV):
//   supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-jobs --use-api --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

// Vonigo up/down state for the DR board banner. service_health is RLS-locked (service-role only), so
// read it with the service key. Returns { isUp, lastChecked, lastChanged } or null if unknown.
async function vonigoHealth(): Promise<Record<string, unknown> | null> {
  try {
    const svc = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data } = await svc.from('service_health').select('is_up, last_checked, last_changed').eq('service', 'vonigo').limit(1);
    const row = data && data[0];
    return row ? { isUp: row.is_up, lastChecked: row.last_checked, lastChanged: row.last_changed } : null;
  } catch { return null; }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function str(v: unknown): string { return v == null ? '' : String(v).trim(); }

// Appointment + its job + provider snapshot. RLS on all three tables scopes to the caller's franchise.
const APPT_SELECT =
  'id, scheduled_date, start_minutes, duration_minutes, status, ' +
  'job:jobs!inner ( id, job_number, status, origin, service_address, service_city, service_state, service_zip, service_lat, service_lng ), ' +
  'snapshot:job_source_snapshot ( import_total, crew_display, customer_display, route_name, synced_at )';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405);

  // Run AS the caller so RLS applies. Reject anonymous / anon-key callers (no real user).
  const authHeader = req.headers.get('Authorization') || '';
  const asUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: userData } = await asUser.auth.getUser();
  if (!userData?.user) return json({ success: false, error: 'unauthorized' }, 401);

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = str(body.action) || 'list';

  try {
    if (action === 'list') {
      const dateFrom = str(body.dateFrom);
      const dateTo = str(body.dateTo);
      if (!dateFrom || !dateTo) return json({ success: false, error: 'dateFrom and dateTo required (YYYY-MM-DD)' }, 400);
      let q = asUser.from('job_appointments').select(APPT_SELECT)
        .gte('scheduled_date', dateFrom).lte('scheduled_date', dateTo)
        .order('scheduled_date', { ascending: true })
        .order('start_minutes', { ascending: true, nullsFirst: true });
      const statuses = Array.isArray(body.status) ? (body.status as unknown[]).map(String) : null;
      if (statuses && statuses.length) q = q.in('status', statuses);
      const { data, error } = await q;
      if (error) throw error;
      return json({ success: true, appointments: shape(data || []), health: await vonigoHealth() });
    }

    if (action === 'get') {
      const jobId = str(body.jobId);
      if (!jobId) return json({ success: false, error: 'jobId required' }, 400);
      const { data: jobRows, error: jErr } = await asUser.from('jobs')
        .select('id, job_number, status, origin, service_address, service_city, service_state, service_zip, service_lat, service_lng')
        .eq('id', jobId).limit(1);
      if (jErr) throw jErr;
      if (!jobRows || !jobRows.length) return json({ success: false, error: 'job_not_found' }, 404);
      const { data: appts, error: aErr } = await asUser.from('job_appointments').select(APPT_SELECT)
        .eq('job_id', jobId).order('scheduled_date', { ascending: true });
      if (aErr) throw aErr;
      return json({ success: true, job: jobRows[0], appointments: shape(appts || []) });
    }

    return json({ success: false, error: 'unknown action' }, 400);
  } catch (e) {
    console.error('[crewlogic-jobs] error:', (e as Error).message);
    return json({ success: false, error: 'read_failed' }, 500);
  }
});

// PostgREST returns the to-one snapshot embed as an object or a 1-element array depending on detection;
// normalize to a single object so the client shape is stable.
function shape(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const snap = r.snapshot;
    return { ...r, snapshot: Array.isArray(snap) ? (snap[0] ?? null) : (snap ?? null) };
  });
}
