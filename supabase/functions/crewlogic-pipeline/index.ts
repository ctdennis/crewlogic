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
const OPEN_STATUS = new Set([160, 161]);        // Open / Booked — the live (non-terminal) statuses
const EST_LABELS = new Set([9996, 9973, 9993]); // Est-Completed-EstOnly / Est-Only / Lost  (NOT 245/9975/9970 = converted)
const EST_LABEL_TEXT: Record<number, string> = { 9996: 'Est. completed — estimate only', 9973: 'Estimate only', 9993: 'Lost' };
// A converted estimate books a SIBLING WorkOrder (the "-2") labeled "Estimate Converted" under the same job.
// If a job has one of these, its estimate visit is NOT unconverted (even though the -1 keeps its estimate label).
const CONVERTED_LABELS = new Set([9970, 9975]); // Est-Converted-EstOnly / Est-Converted-Job
const UNCONV_RECHECK_HOURS = 12;                // how often to re-check a still-unconverted estimate's email trail
// UCB lane is matched by route_name (~URGENTCB) off the mirror; the Vonigo route objectID (2987) is no longer needed.
const ALL_TYPES = ['lead', 'unconverted_estimate', 'cancellation', 'ucb', 'case'];

// Starter sequences seeded per franchise on first use (then owner-editable). Each is the auto-default for
// its item type (hybrid: new items auto-enter it; the owner can reassign). Email/text steps carry a
// template (merge fields {{first_name}}, {{franchise}}) the human sends — NO auto-send in v1.
type SeqStep = { delay_value: number; delay_unit: string; channel: string; subject?: string; body?: string };
const STARTER_SEQUENCES: { name: string; description: string; default_for_type: string; steps: SeqStep[] }[] = [
  { name: 'Standard Lead', default_for_type: 'lead', description: 'Default follow-up for a new lead.', steps: [
    { delay_value: 1, delay_unit: 'day', channel: 'call' },
    { delay_value: 2, delay_unit: 'day', channel: 'text', body: 'Hi {{first_name}}, following up on your junk removal — happy to grab a time that works. — {{franchise}}' },
    { delay_value: 5, delay_unit: 'day', channel: 'email', subject: 'Still looking to clear that clutter?', body: 'Hi {{first_name}},\n\nJust checking back — we’d love to help with your junk removal. Reply here or give us a call and we’ll get you scheduled.\n\nThanks,\n{{franchise}}' },
  ] },
  { name: 'Reschedule Follow-up', default_for_type: 'cancellation', description: 'Win back a cancelled / rescheduled job.', steps: [
    { delay_value: 5, delay_unit: 'day', channel: 'call' },
  ] },
  { name: 'Estimate Drip', default_for_type: 'unconverted_estimate', description: 'Follow up on an estimate that hasn’t booked.', steps: [
    { delay_value: 1, delay_unit: 'day', channel: 'call' },
    { delay_value: 3, delay_unit: 'day', channel: 'email', subject: 'Your junk removal estimate', body: 'Hi {{first_name}},\n\nWanted to follow up on the estimate we put together — any questions, or shall we get you on the schedule?\n\n{{franchise}}' },
    { delay_value: 7, delay_unit: 'day', channel: 'text', body: 'Hi {{first_name}}, still happy to honor your estimate — want me to book a time?' },
    { delay_value: 14, delay_unit: 'day', channel: 'call' },
  ] },
  { name: 'Urgent Callback', default_for_type: 'ucb', description: 'Work the urgent call-back queue.', steps: [
    { delay_value: 0, delay_unit: 'day', channel: 'call' },
  ] },
  { name: 'Case Callback', default_for_type: 'case', description: 'Call the customer about an open case.', steps: [
    { delay_value: 1, delay_unit: 'day', channel: 'call' },
  ] },
];

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

type SB = ReturnType<typeof createClient>;
// day/week/month delay → ISO (real month math for the month unit).
function dueFrom(base: Date, value: number, unit: string): string {
  const d = new Date(base.getTime());
  if (unit === 'week') d.setUTCDate(d.getUTCDate() + value * 7);
  else if (unit === 'month') d.setUTCMonth(d.getUTCMonth() + value);
  else d.setUTCDate(d.getUTCDate() + value);
  return d.toISOString();
}
// Seed a franchise's starter sequences once (idempotent — skips if any already exist).
async function ensureStarterSequences(supabase: SB, tenant: string, franchiseInternalID: string) {
  const { data: existing } = await supabase.from('pipeline_sequences').select('id').eq('franchise_id', franchiseInternalID).limit(1);
  if (existing && existing.length) return;
  for (const s of STARTER_SEQUENCES) {
    const { data: seq } = await supabase.from('pipeline_sequences').insert({ tenant_id: tenant, franchise_id: franchiseInternalID, name: s.name, description: s.description, default_for_type: s.default_for_type }).select('id').single();
    if (seq) await supabase.from('pipeline_sequence_steps').insert(s.steps.map((st, i) => ({ sequence_id: (seq as { id: string }).id, sort_order: i, delay_value: st.delay_value, delay_unit: st.delay_unit, channel: st.channel, subject: st.subject || null, body: st.body || null })));
  }
}
// Put one item on a sequence: replace its scheduled touches with fresh ones from the sequence's steps,
// anchored to `anchor` (default now). The next_action_at trigger keeps the tickler in sync.
async function seedTouches(supabase: SB, itemId: string, seq: { id: string; name: string }, franchiseInternalID: string, anchor?: Date) {
  const { data: steps } = await supabase.from('pipeline_sequence_steps').select('id, delay_value, delay_unit, channel').eq('sequence_id', seq.id).order('sort_order', { ascending: true });
  await supabase.from('pipeline_touches').update({ status: 'skipped' }).eq('pipeline_item_id', itemId).eq('status', 'scheduled');
  const base = anchor || new Date();
  const touches = ((steps || []) as Record<string, unknown>[]).map((st) => ({ pipeline_item_id: itemId, sequence_step_id: st.id, due_at: dueFrom(base, Number(st.delay_value), String(st.delay_unit)), channel: st.channel, status: 'scheduled' }));
  if (touches.length) await supabase.from('pipeline_touches').insert(touches);
  await supabase.from('pipeline_items').update({ sequence_id: seq.id, cadence: seq.name, updated_at: new Date().toISOString() }).eq('id', itemId).eq('franchise_id', franchiseInternalID);
  return touches.length;
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

// Estimate conversion via the Vonigo email trail: a converted estimate books a SECOND work order (the "-2"), which
// fires a "…Work Order, ID: <job>-2…" email. That email is created at booking time, so it exists even when the -2
// job is future-dated and not yet in the local mirror (the case the label heuristic misses). Reschedules stay on
// "-1", so a reference to "-2" (or higher) means a new booked job = converted.
async function estimateConvertedByEmail(token: string, jobExtId: string): Promise<boolean> {
  const digits = jobExtId.replace(/[^0-9]/g, '');
  if (!digits) return false;
  const r = await vpost('/data/Emails/', { securityToken: token, sortMode: '1', sortDirection: '0', jobID: digits });
  if (r.errNo !== 0) return false;
  const re = new RegExp('Work Order, ID:\\s*' + digits + '-(\\d+)');
  for (const e of (r.Emails as Record<string, unknown>[]) || []) {
    const m = String(e.name || '').match(re);
    if (m && parseInt(m[1], 10) >= 2) return true;
  }
  return false;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  const reqId = crypto.randomUUID().slice(0, 8);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    const franchiseID = String(body.franchiseID || '').trim();
    const ACTIONS = ['sync', 'list', 'reminders', 'detail', 'update', 'dismiss', 'touchDone', 'snooze', 'seqList', 'seqSave', 'seqDelete', 'assignSequence', 'unassignSequence', 'avgJobSize'];
    if (!ACTIONS.includes(action)) return json({ success: false, error: 'unknown action', reqId }, 400);
    if (!franchiseID) return json({ success: false, error: 'franchiseID required', reqId }, 400);

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: fr, error: fe } = await supabase.from('franchises').select('id').eq('external_id', franchiseID).eq('tenant_id', TENANT_ID).single();
    if (fe || !fr) return json({ success: false, error: 'Franchise not found: ' + franchiseID, reqId }, 404);
    const franchiseInternalID = (fr as { id: string }).id;
    const CLOSED = new Set(['won', 'lost', 'dismissed', 'resolved']);
    const ownItem = async (id: string) => (await supabase.from('pipeline_items').select('id').eq('id', id).eq('franchise_id', franchiseInternalID).maybeSingle()).data; // franchise-scope guard

    // ===== AVG JOB SIZE (read-only) — average closed-job revenue over the last 30 days from the job mirror =====
    // Closed job = job_appointments.status='done' (Vonigo WorkOrder status 164 Completed / 165 Archived, per the
    // importer's apptStatus). Revenue = job_source_snapshot.import_total (woPrice field 813 at import time).
    // Franchise-scoped. Returns { avg, count, sumRevenue, days:30 } — a suggestion the owner may Apply; no writes.
    if (action === 'avgJobSize') {
      const days = 30;
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10); // YYYY-MM-DD
      const { data: rows, error: err } = await supabase
        .from('job_source_snapshot')
        .select('import_total, job_appointments!inner(status, scheduled_date)')
        .eq('franchise_id', franchiseInternalID)
        .eq('job_appointments.status', 'done')
        .gte('job_appointments.scheduled_date', cutoff);
      if (err) return json({ success: false, error: err.message, reqId }, 500);
      let sum = 0, count = 0;
      for (const r of ((rows || []) as Record<string, unknown>[])) {
        const v = Number(r.import_total);
        if (Number.isFinite(v) && v > 0) { sum += v; count++; }
      }
      const avg = count > 0 ? Math.round(sum / count) : 0;
      return json({ success: true, avg, count, sumRevenue: Math.round(sum), days, reqId });
    }

    // ===== CRM actions (DB only; no Vonigo) =====
    if (action === 'list') {
      const COLS = 'id, type, source_provider, source_external_id, customer_name, phone, email, address, zip, amount, reason, detail, occurred_at, stage, assigned_to, next_action_at, sequence_id, cadence, notes, last_synced_at';
      let q = supabase.from('pipeline_items').select(COLS).eq('franchise_id', franchiseInternalID);
      if (Array.isArray(body.types) && body.types.length) q = q.in('type', body.types.map(String));
      if (Array.isArray(body.stages) && body.stages.length) q = q.in('stage', body.stages.map(String));
      if (body.assignee) q = q.eq('assigned_to', String(body.assignee));
      if (body.search) q = q.ilike('customer_name', '%' + String(body.search) + '%');
      if (String(body.view || '') === 'attention') q = q.not('stage', 'in', '(won,lost,dismissed,resolved)');
      q = q.order('next_action_at', { ascending: true, nullsFirst: false }).order('occurred_at', { ascending: false })
        .limit(Math.min(parseInt(String(body.limit || '400'), 10) || 400, 1000));
      const { data: items, error } = await q;
      if (error) throw error;
      const ids = (items || []).map((i: Record<string, unknown>) => i.id as string);
      const touchByItem: Record<string, { dueAt: string; channel: string }> = {};
      if (ids.length) {
        const { data: ts } = await supabase.from('pipeline_touches').select('pipeline_item_id, due_at, channel').eq('status', 'scheduled').in('pipeline_item_id', ids).order('due_at', { ascending: true });
        for (const t of (ts || []) as Record<string, unknown>[]) { const k = String(t.pipeline_item_id); if (!touchByItem[k]) touchByItem[k] = { dueAt: t.due_at as string, channel: t.channel as string }; }
      }
      const out = (items || []).map((i: Record<string, unknown>) => ({ ...i, nextTouch: touchByItem[i.id as string] || null }));
      // ── Bizdev enrichment: match unconverted_estimate items to their CrewLogic estimate row (the real quote
      //    total_price) and expose the Vonigo jobID for a deep-link. The WO price field (813) is 0 for estimates,
      //    so the CrewLogic estimate is the only real $ source; when present it overwrites amount. Two indexed reads.
      const estOut = out.filter((i: Record<string, unknown>) => i.type === 'unconverted_estimate');
      if (estOut.length) {
        const { data: rawRows } = await supabase.from('pipeline_items').select('id, raw')
          .eq('franchise_id', franchiseInternalID).eq('type', 'unconverted_estimate');
        const jobByItem: Record<string, string> = {}; const jobIds: string[] = [];
        for (const r of (rawRows || []) as Record<string, unknown>[]) {
          const rels = (((r.raw as Record<string, unknown>) || {}).Relations as VRel[]) || [];
          const j = (rels || []).find((x) => x && x.relationType === 'job');
          if (j && j.objectID != null) { const jid = String(j.objectID); jobByItem[String(r.id)] = jid; jobIds.push(jid); }
        }
        const estByJob: Record<string, Record<string, unknown>> = {};
        if (jobIds.length) {
          const { data: ests } = await supabase.from('estimates')
            .select('estimate_id, job_id, total_price, status, deleted_at')
            .eq('franchise_id', franchiseInternalID).in('job_id', jobIds);
          for (const e of (ests || []) as Record<string, unknown>[]) {
            if (e.deleted_at) continue;
            const k = String(e.job_id); const prev = estByJob[k];
            if (!prev || Number(e.total_price || 0) > Number(prev.total_price || 0)) estByJob[k] = e; // keep the most-priced match
          }
        }
        for (const it of estOut) {
          const jid = jobByItem[String(it.id)] || null;
          it.vonigo_job_id = jid;
          const e = jid ? estByJob[jid] : null;
          if (e) {
            it.cl_present = true;
            it.cl_estimate_id = e.estimate_id;
            it.cl_status = e.status;
            it.cl_total_price = Number(e.total_price || 0);
            if ((it.amount == null || Number(it.amount) === 0) && Number(e.total_price || 0) > 0) it.amount = Number(e.total_price);
          } else { it.cl_present = false; }
        }
      }
      const { data: allT } = await supabase.from('pipeline_items').select('type, stage').eq('franchise_id', franchiseInternalID);
      const counts: Record<string, number> = {}; let open = 0;
      for (const r of (allT || []) as Record<string, string>[]) { counts[r.type] = (counts[r.type] || 0) + 1; if (!CLOSED.has(r.stage)) open++; }
      return json({ success: true, items: out, counts, open, total: out.length, reqId });
    }

    // Full detail for one item (incl. the stored `raw` Vonigo object) — powers the row detail modal. On demand
    // (not in `list`) so the list payload stays small. Also returns the item's scheduled touches.
    if (action === 'detail') {
      const id = String(body.id || ''); if (!id) return json({ success: false, error: 'id required', reqId }, 400);
      const { data: item } = await supabase.from('pipeline_items').select('*').eq('id', id).eq('franchise_id', franchiseInternalID).maybeSingle();
      if (!item) return json({ success: false, error: 'not found', reqId }, 404);
      const { data: touches } = await supabase.from('pipeline_touches').select('id, due_at, channel, status, note, sequence_step_id').eq('pipeline_item_id', id).order('due_at', { ascending: true });
      let seqName: string | null = null;
      if ((item as Record<string, unknown>).sequence_id) {
        const { data: s } = await supabase.from('pipeline_sequences').select('name').eq('id', (item as Record<string, unknown>).sequence_id).maybeSingle();
        seqName = s ? (s as { name: string }).name : null;
      }
      return json({ success: true, item, touches: touches || [], sequenceName: seqName, reqId });
    }

    // Compact due-reminder feed for the Dispatch follow-ups rail + day dots. Open items with a scheduled next
    // touch, ordered by due; carries the touchId so the rail's Done/Snooze can act without a second lookup.
    if (action === 'reminders') {
      const { data: items } = await supabase.from('pipeline_items')
        .select('id, type, customer_name, phone, email, next_action_at, stage')
        .eq('franchise_id', franchiseInternalID)
        .not('next_action_at', 'is', null)
        .not('stage', 'in', '(won,lost,dismissed,resolved)')
        .order('next_action_at', { ascending: true }).limit(300);
      const ids = (items || []).map((i: Record<string, unknown>) => i.id as string);
      const touchByItem: Record<string, { touchId: string; dueAt: string; channel: string }> = {};
      if (ids.length) {
        const { data: ts } = await supabase.from('pipeline_touches').select('id, pipeline_item_id, due_at, channel').eq('status', 'scheduled').in('pipeline_item_id', ids).order('due_at', { ascending: true });
        for (const t of (ts || []) as Record<string, unknown>[]) { const k = String(t.pipeline_item_id); if (!touchByItem[k]) touchByItem[k] = { touchId: t.id as string, dueAt: t.due_at as string, channel: t.channel as string }; }
      }
      const out = (items || []).map((i: Record<string, unknown>) => ({ ...i, nextTouch: touchByItem[i.id as string] || null })).filter((i) => i.nextTouch);
      return json({ success: true, reminders: out, reqId });
    }

    if (action === 'update' || action === 'dismiss') {
      const id = String(body.id || ''); if (!id) return json({ success: false, error: 'id required', reqId }, 400);
      if (!(await ownItem(id))) return json({ success: false, error: 'not found', reqId }, 404);
      const p = (body.patch || {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (action === 'dismiss') patch.stage = 'dismissed';
      for (const k of ['stage', 'assigned_to', 'notes', 'cadence', 'close_reason']) if (k in p) patch[k] = p[k] == null ? null : String(p[k]);
      if ('next_action_at' in p) patch.next_action_at = p.next_action_at || null;
      const { error } = await supabase.from('pipeline_items').update(patch).eq('id', id).eq('franchise_id', franchiseInternalID);
      if (error) throw error;
      // closing (won/lost/dismissed) → skip open touches; the trigger clears next_action_at.
      if (CLOSED.has(String(patch.stage || ''))) await supabase.from('pipeline_touches').update({ status: 'skipped' }).eq('pipeline_item_id', id).eq('status', 'scheduled');
      return json({ success: true, reqId });
    }

    if (action === 'touchDone') {
      const touchId = String(body.touchId || ''); if (!touchId) return json({ success: false, error: 'touchId required', reqId }, 400);
      const { data: t } = await supabase.from('pipeline_touches').select('pipeline_item_id').eq('id', touchId).maybeSingle();
      if (!t || !(await ownItem(String((t as { pipeline_item_id: string }).pipeline_item_id)))) return json({ success: false, error: 'not found', reqId }, 404);
      await supabase.from('pipeline_touches').update({ status: 'done', done_at: new Date().toISOString() }).eq('id', touchId); // trigger recomputes next_action_at
      return json({ success: true, reqId });
    }
    if (action === 'snooze') {
      // Reschedule the WHOLE remaining follow-up plan for an item: shift EVERY scheduled touch so the earliest
      // lands on `dueAt`, preserving the spacing of later steps. (Owner 2026-08-11: "push this out to next week"
      // must defer the customer — a single-touch snooze left the next sequence step surfacing the very next day.)
      const dueAt = String(body.dueAt || ''); if (!dueAt) return json({ success: false, error: 'dueAt required', reqId }, 400);
      const target = new Date(dueAt).getTime(); if (!Number.isFinite(target)) return json({ success: false, error: 'bad dueAt', reqId }, 400);
      let itemId = String(body.itemId || '');
      if (!itemId) { // back-compat: derive the item from a touchId
        const tid = String(body.touchId || ''); if (!tid) return json({ success: false, error: 'itemId or touchId required', reqId }, 400);
        const { data: t } = await supabase.from('pipeline_touches').select('pipeline_item_id').eq('id', tid).maybeSingle();
        if (!t) return json({ success: false, error: 'not found', reqId }, 404);
        itemId = String((t as { pipeline_item_id: string }).pipeline_item_id);
      }
      if (!(await ownItem(itemId))) return json({ success: false, error: 'not found', reqId }, 404);
      const { data: ts } = await supabase.from('pipeline_touches').select('id, due_at').eq('pipeline_item_id', itemId).eq('status', 'scheduled').order('due_at', { ascending: true });
      const list = (ts || []) as { id: string; due_at: string }[];
      if (!list.length) return json({ success: true, shifted: 0, reqId });
      const delta = target - new Date(list[0].due_at).getTime();
      for (const t of list) { const nd = new Date(new Date(t.due_at).getTime() + delta).toISOString(); await supabase.from('pipeline_touches').update({ due_at: nd }).eq('id', t.id); }
      return json({ success: true, shifted: list.length, reqId });
    }

    // ===== SEQUENCES =====
    if (action === 'seqList') {
      await ensureStarterSequences(supabase, TENANT_ID, franchiseInternalID);
      const { data: seqs } = await supabase.from('pipeline_sequences').select('*').eq('franchise_id', franchiseInternalID).order('created_at', { ascending: true });
      const ids = (seqs || []).map((s: Record<string, unknown>) => s.id as string);
      const stepsBySeq: Record<string, unknown[]> = {};
      if (ids.length) {
        const { data: steps } = await supabase.from('pipeline_sequence_steps').select('*').in('sequence_id', ids).order('sort_order', { ascending: true });
        for (const st of (steps || []) as Record<string, unknown>[]) { const k = String(st.sequence_id); (stepsBySeq[k] = stepsBySeq[k] || []).push(st); }
      }
      return json({ success: true, sequences: (seqs || []).map((s: Record<string, unknown>) => ({ ...s, steps: stepsBySeq[s.id as string] || [] })), reqId });
    }

    if (action === 'seqSave') {
      const s = (body.sequence || {}) as Record<string, unknown>;
      const name = String(s.name || '').trim(); if (!name) return json({ success: false, error: 'name required', reqId }, 400);
      const fields = { tenant_id: TENANT_ID, franchise_id: franchiseInternalID, name, description: s.description ? String(s.description) : null, default_for_type: s.default_for_type ? String(s.default_for_type) : null, active: s.active === false ? false : true, updated_at: new Date().toISOString() };
      let seqId = s.id ? String(s.id) : '';
      if (seqId) { if (!(await (async () => (await supabase.from('pipeline_sequences').select('id').eq('id', seqId).eq('franchise_id', franchiseInternalID).maybeSingle()).data)())) return json({ success: false, error: 'not found', reqId }, 404); await supabase.from('pipeline_sequences').update(fields).eq('id', seqId).eq('franchise_id', franchiseInternalID); }
      else { const { data: ins, error } = await supabase.from('pipeline_sequences').insert(fields).select('id').single(); if (error || !ins) return json({ success: false, error: 'save failed', reqId }, 500); seqId = (ins as { id: string }).id; }
      if (Array.isArray(s.steps)) { // replace the step set
        await supabase.from('pipeline_sequence_steps').delete().eq('sequence_id', seqId);
        const rows = (s.steps as Record<string, unknown>[]).map((st, i) => ({ sequence_id: seqId, sort_order: Number(st.sort_order ?? i), delay_value: Math.max(0, parseInt(String(st.delay_value ?? 0), 10) || 0), delay_unit: ['day', 'week', 'month'].includes(String(st.delay_unit)) ? String(st.delay_unit) : 'day', channel: ['call', 'email', 'text', 'task'].includes(String(st.channel)) ? String(st.channel) : 'call', subject: st.subject ? String(st.subject) : null, body: st.body ? String(st.body) : null }));
        if (rows.length) await supabase.from('pipeline_sequence_steps').insert(rows);
      }
      return json({ success: true, id: seqId, reqId });
    }

    if (action === 'seqDelete') {
      const seqId = String(body.sequenceId || ''); if (!seqId) return json({ success: false, error: 'sequenceId required', reqId }, 400);
      await supabase.from('pipeline_items').update({ sequence_id: null, cadence: null }).eq('sequence_id', seqId).eq('franchise_id', franchiseInternalID); // detach items
      const { error } = await supabase.from('pipeline_sequences').delete().eq('id', seqId).eq('franchise_id', franchiseInternalID);
      if (error) throw error;
      return json({ success: true, reqId });
    }

    if (action === 'assignSequence') {
      const id = String(body.id || ''); const sequenceId = String(body.sequenceId || '');
      if (!id || !sequenceId) return json({ success: false, error: 'id and sequenceId required', reqId }, 400);
      if (!(await ownItem(id))) return json({ success: false, error: 'not found', reqId }, 404);
      const { data: seq } = await supabase.from('pipeline_sequences').select('id, name').eq('id', sequenceId).eq('franchise_id', franchiseInternalID).maybeSingle();
      if (!seq) return json({ success: false, error: 'sequence not found', reqId }, 404);
      const n = await seedTouches(supabase, id, seq as { id: string; name: string }, franchiseInternalID);
      return json({ success: true, touches: n, reqId });
    }

    if (action === 'unassignSequence') {
      const id = String(body.id || ''); if (!id) return json({ success: false, error: 'id required', reqId }, 400);
      if (!(await ownItem(id))) return json({ success: false, error: 'not found', reqId }, 404);
      await supabase.from('pipeline_touches').update({ status: 'skipped' }).eq('pipeline_item_id', id).eq('status', 'scheduled'); // trigger clears next_action_at
      await supabase.from('pipeline_items').update({ sequence_id: null, cadence: null, updated_at: new Date().toISOString() }).eq('id', id).eq('franchise_id', franchiseInternalID);
      return json({ success: true, reqId });
    }

    // ===== sync (Vonigo adapter) — fall-through =====
    const types: string[] = Array.isArray(body.types) && body.types.length ? body.types.map(String) : ALL_TYPES;
    const want = (t: string) => types.includes(t);
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

    // Incremental cache: what we ALREADY have for leads (phone/email) and cancellations (reason). The per-item
    // Vonigo enrichment calls (a Contact fetch per lead, a Job fetch per cancel) dominate the sync time (~220 calls
    // for #90). Once we've fetched an item's contact/reason it doesn't change, so a repeat "Sync now" reuses the
    // stored value and skips the call → the first sync is slow, every re-sync is fast.
    const knownLeadContact = new Map<string, { phone: string | null; email: string | null }>();
    const knownCancelReason = new Map<string, { reason: string | null; detail: string | null }>();
    {
      const { data: kl } = await supabase.from('pipeline_items').select('source_external_id, phone, email').eq('franchise_id', franchiseInternalID).eq('type', 'lead');
      for (const r of (kl || []) as Record<string, string | null>[]) knownLeadContact.set(String(r.source_external_id), { phone: r.phone, email: r.email });
      const { data: kc } = await supabase.from('pipeline_items').select('source_external_id, reason, detail').eq('franchise_id', franchiseInternalID).eq('type', 'cancellation');
      for (const r of (kc || []) as Record<string, string | null>[]) knownCancelReason.set(String(r.source_external_id), { reason: r.reason, detail: r.detail });
    }

    const rows: Record<string, unknown>[] = [];
    const mk = (type: string, source_object: string, source_external_id: string, extra: Record<string, unknown>) => ({
      tenant_id: TENANT_ID, franchise_id: franchiseInternalID, type, source_provider: 'vonigo',
      source_object, source_external_id, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...extra,
    });

    // WorkOrder-derived types (cancellation / unconverted_estimate / ucb) are READ FROM THE LOCAL JOB MIRROR
    // (job_appointments + job_source_snapshot), which crewlogic-vonigo-import already keeps fresh (prod: every
    // 15 min + a nightly ~90-day backfill). This replaces the old per-sync Vonigo WorkOrders scan (the 120-day UCB
    // scan alone was ~57s) — now a couple of indexed DB reads. We read the TRUE status/label from the stored `raw`
    // WO so recognition matches the Vonigo-direct path exactly (the mirror's normalized `status` maps 163→'working',
    // which we must NOT rely on). Leads (Clients) and cases aren't jobs, so they still pull from Vonigo below.
    const SNAP_SELECT = 'label_optionid, route_name, customer_display, import_total, raw, job_appointments!inner(source_external_id, scheduled_date, status, job_id)';
    const mirrorWO = (row: Record<string, unknown>) => {
      const ja = (row.job_appointments || {}) as Record<string, unknown>;
      const raw = (row.raw || {}) as Record<string, unknown>;
      const fields = (raw.Fields as VField[]) || []; const rels = (raw.Relations as VRel[]) || [];
      const cd = (row.customer_display || {}) as Record<string, string | null>;
      const woEpoch = parseInt(String(getField(fields, F.woDate)?.fieldValue || '0'), 10);
      return {
        woID: String(ja.source_external_id ?? ''), jobId: String(ja.job_id ?? ''), jobExtId: String(rel(rels, 'job')?.objectID ?? ''), fields, rels, woEpoch,
        status: getField(fields, F.woStatus)?.optionID || 0,
        label: getField(fields, F.woLabel)?.optionID || 0,
        base: {
          customer_name: cd.name || rel(rels, 'client')?.name || '',
          phone: cd.phone || null, email: cd.email || null,
          address: getField(fields, F.woAddress)?.fieldValue || null,
          amount: row.import_total != null ? Number(row.import_total) : num(getField(fields, F.woPrice)?.fieldValue),
          occurred_at: iso(getField(fields, F.woDate)?.fieldValue), raw,
        },
      };
    };

    // Passes A / A2 / B / C hit independent Vonigo endpoints and only push to `rows`, so run them CONCURRENTLY
    // (was sequential → the ~220 per-item Contact/Job lookups summed to ~80s; overlapping them cuts wall-time to
    // roughly the slowest single pass). Each pass is a self-contained async task; Promise.all awaits them below.
    // ---- A) cancellation + unconverted_estimate — from the mirror (recent window by WO service date) ----
    const _passA = (want('cancellation') || want('unconverted_estimate')) ? (async () => {
      if (want('unconverted_estimate')) {
        // Fast-path (free): a job with an in-mirror "Estimate Converted" sibling (9970/9975) is converted — exclude
        // its estimate visit even though the -1 keeps its "Estimate Completed" label. (Owner 2026-08-10.)
        const { data: convRows } = await supabase.from('job_source_snapshot').select('job_appointments!inner(job_id)').eq('franchise_id', franchiseInternalID).in('label_optionid', [...CONVERTED_LABELS]);
        const convertedJobs = new Set(((convRows || []) as Record<string, unknown>[]).map((r) => String((r.job_appointments as Record<string, unknown>)?.job_id ?? '')));
        const { data } = await supabase.from('job_source_snapshot').select(SNAP_SELECT).eq('franchise_id', franchiseInternalID).in('label_optionid', [...EST_LABELS]);
        const cands = ((data || []) as Record<string, unknown>[]).map(mirrorWO)
          .filter((w) => w.woID && !(w.woEpoch && w.woEpoch < dateStart) && !(w.jobId && convertedJobs.has(w.jobId)));

        // Fallback (email trail): catch conversions the mirror can't see yet (the -2 job is future-dated). Only check
        // jobs we haven't recently verified; cache the verdict (converted = permanent, unconverted re-checked after TTL).
        const jobIds = [...new Set(cands.map((w) => w.jobExtId).filter(Boolean))];
        const cache = new Map<string, boolean>();
        if (jobIds.length) {
          const { data: cc } = await supabase.from('pipeline_conversion_cache').select('job_external_id, converted, checked_at').eq('franchise_id', franchiseInternalID).in('job_external_id', jobIds);
          const staleMs = UNCONV_RECHECK_HOURS * 3600 * 1000, nowMs = Date.now();
          const fresh = new Set<string>();
          for (const r of (cc || []) as Record<string, unknown>[]) {
            const conv = !!r.converted; cache.set(String(r.job_external_id), conv);
            if (conv || (nowMs - Date.parse(String(r.checked_at))) <= staleMs) fresh.add(String(r.job_external_id)); // no re-check needed
          }
          const toCheck = jobIds.filter((jid) => !fresh.has(jid));
          if (toCheck.length) {
            const results = await mapPool(toCheck, 6, async (jid) => ({ jid, converted: await estimateConvertedByEmail(token, jid) }));
            await supabase.from('pipeline_conversion_cache').upsert(results.map((r) => ({ franchise_id: franchiseInternalID, job_external_id: r.jid, converted: r.converted, checked_at: new Date().toISOString() })), { onConflict: 'franchise_id,job_external_id' });
            for (const r of results) cache.set(r.jid, r.converted);
          }
        }
        for (const w of cands) {
          if (w.jobExtId && cache.get(w.jobExtId)) continue;   // converted per the email trail
          rows.push(mk('unconverted_estimate', 'workorder', w.woID, { ...w.base, reason: getField(w.fields, F.woLabel)?.fieldValue || EST_LABEL_TEXT[w.label] || String(w.label) }));
        }
      }
      if (want('cancellation')) {
        // 162 Cancelled / 163 Cancelled-Today. The mirror normalizes those to 'cancelled'/'working'; we verify the
        // raw optionID (CANCEL_STATUS) so the importer's status naming can't misclassify us.
        const { data } = await supabase.from('job_source_snapshot').select(SNAP_SELECT).eq('franchise_id', franchiseInternalID).in('job_appointments.status', ['cancelled', 'working']);
        const cands = ((data || []) as Record<string, unknown>[]).map(mirrorWO).filter((w) => w.woID && CANCEL_STATUS.has(w.status) && (!w.woEpoch || w.woEpoch >= dateStart));
        // Reason still comes from the Vonigo Job (not mirrored) — cached, so only brand-new cancels hit Vonigo.
        await mapPool(cands, 6, async (w) => {
          let reason: string | null = null, detail: string | null = null;
          const cached = knownCancelReason.get(w.woID);
          if (cached && cached.reason) { reason = cached.reason; detail = cached.detail; }
          else {
            const jobID = rel(w.rels, 'job')?.objectID;
            if (jobID != null) {
              try {
                const jr = await vpost('/data/Jobs/', { securityToken: token, method: '-2', objectID: String(jobID), isCompleteObject: 'true' });
                const jf = (jr.Fields as VField[]) || [];
                const cat = getField(jf, F.jobCancelCat)?.fieldValue || '';
                const rsn = getField(jf, F.jobCancelReason)?.fieldValue || '';
                reason = [cat, rsn].filter(Boolean).join(' · ') || null;
                detail = getField(jf, F.jobCancelComments)?.fieldValue || null;
              } catch { /* reason optional */ }
            }
          }
          rows.push(mk('cancellation', 'workorder', w.woID, { ...w.base, reason, detail }));
        });
      }
    })() : Promise.resolve();

    // ---- A2) UCB = OPEN WorkOrders on the URGENTCB lane — from the mirror (no date window; the lane is a backlog) ----
    // Keep ONLY open statuses (160/161): a cancelled WO keeps its last route (URGENTCB) but has dropped off the lane
    // in Vonigo's view. (2026-08-10: #90's lane shows 4 open callbacks; a cancelled 5th, Shaw, correctly excluded.)
    const _passUCB = want('ucb') ? (async () => {
      const { data } = await supabase.from('job_source_snapshot').select(SNAP_SELECT).eq('franchise_id', franchiseInternalID).ilike('route_name', '%urgentcb%');
      for (const row of (data || []) as Record<string, unknown>[]) {
        const w = mirrorWO(row);
        if (!w.woID || !OPEN_STATUS.has(w.status)) continue;
        rows.push(mk('ucb', 'workorder', w.woID, { ...w.base, reason: getField(w.fields, F.woLabel)?.fieldValue || null }));
      }
    })() : Promise.resolve();

    // ---- B) Leads = Clients (created-date) with stage 123 == "Lead"; phone/email from the Contact ----
    const _passLeads = want('lead') ? (async () => {
      // Clients pages fetched concurrently (was 20 sequential pages). Read the plural `Clients` key, keep stage=="Lead".
      const clientPages = await mapPool(Array.from({ length: 20 }, (_, i) => i + 1), 5, async (pg) => {
        const r = await vpost('/data/Clients/', { securityToken: token, franchiseID, method: '-1', dateMode: '1', dateStart: String(dateStart), dateEnd: String(dateEnd), pageNo: String(pg), pageSize: '50', isCompleteObject: 'true' });
        return r.errNo === 0 ? ((r.Clients as Record<string, unknown>[]) || []) : [];
      });
      const leads = clientPages.flat().filter((c) => (getField(c.Fields as VField[], F.clientStage)?.fieldValue || '') === 'Lead');
      await mapPool(leads, 6, async (c) => {
        const fields = c.Fields as VField[]; const rels = c.Relations as VRel[];
        let phone: string | null = null, email: string | null = null;
        const cachedC = knownLeadContact.get(String(c.objectID));
        if (cachedC && cachedC.phone) { phone = cachedC.phone; email = cachedC.email; } // already fetched — skip the Contact call
        else {
          const contactId = rel(rels, 'contact')?.objectID;
          if (contactId != null) {
            try {
              const cr = await vpost('/data/Contacts/', { securityToken: token, method: '0', objectID: String(contactId), isCompleteObject: 'true' });
              const ct = (cr.Contacts && cr.Contacts[0]) || null;
              if (ct) { const cf = ct.Fields as VField[]; phone = getField(cf, F.contactPhone)?.fieldValue || null; email = emailish(cf); }
            } catch { /* contact optional */ }
          }
        }
        rows.push(mk('lead', 'client', String(c.objectID), {
          customer_name: String(c.name || ''), phone, email,
          address: (fields || []).map((f) => f.fieldValue).find((v) => /\d/.test(String(v)) && /,/.test(String(v))) || null,
          occurred_at: iso(c.dateCreated), raw: c,
        }));
      });
    })() : Promise.resolve();

    // ---- C) Cases = /data/Cases plural key (franchise's own) ----
    const _passCases = want('case') ? (async () => {
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
    })() : Promise.resolve();

    await Promise.all([_passA, _passUCB, _passLeads, _passCases]);

    // Which (type, external_id) already exist? → so we auto-seed ONLY brand-new items (not the whole backlog
    // on every sync, and never re-seeding an item the owner deliberately took off its sequence).
    const { data: existRows } = await supabase.from('pipeline_items').select('type, source_external_id').eq('franchise_id', franchiseInternalID);
    const existKeys = new Set(((existRows || []) as Record<string, string>[]).map((r) => r.type + '|' + r.source_external_id));

    // ---- Upsert (merge-duplicates): only source-derived cols in the payload → CRM fields preserved. ----
    let upserted = 0;
    if (rows.length) {
      const { error } = await supabase.from('pipeline_items').upsert(rows, { onConflict: 'tenant_id,type,source_external_id' });
      if (error) { console.error(`[pipeline:${reqId}] upsert failed:`, error); return json({ success: false, error: 'Save failed', reqId }, 500); }
      upserted = rows.length;
    }

    // Hybrid auto-default: brand-new items auto-enter their type's default sequence (schedule starts now).
    const newKeys = new Set(rows.filter((r) => !existKeys.has(String(r.type) + '|' + String(r.source_external_id))).map((r) => String(r.type) + '|' + String(r.source_external_id)));
    let autoSeeded = 0;
    if (newKeys.size) {
      await ensureStarterSequences(supabase, TENANT_ID, franchiseInternalID);
      const { data: defs } = await supabase.from('pipeline_sequences').select('id, name, default_for_type').eq('franchise_id', franchiseInternalID).eq('active', true).not('default_for_type', 'is', null);
      const defByType: Record<string, { id: string; name: string }> = {};
      for (const d of (defs || []) as Record<string, string>[]) defByType[d.default_for_type] = { id: d.id, name: d.name };
      const { data: freshItems } = await supabase.from('pipeline_items').select('id, type, source_external_id, occurred_at').eq('franchise_id', franchiseInternalID);
      // Option A (owner 2026-08-11): auto-enroll only GENUINELY-NEW items, never the historical backlog. Guard by
      // recency — an item whose event date is within AUTO_SEED_MAX_AGE_DAYS (or in the future) auto-seeds; older
      // backlog stays in the list unscheduled until the owner assigns a sequence. Prevents the whole backlog
      // stacking its first follow-up on one calendar day (the "186 due today" pile-up).
      const AUTO_SEED_MAX_AGE_DAYS = 3, AUTO_SEED_MAX_AGE_MS = AUTO_SEED_MAX_AGE_DAYS * 86400000, _nowMs = Date.now();
      const _recentEnough = (occ: unknown) => { if (!occ) return false; const ts = new Date(String(occ)).getTime(); return Number.isFinite(ts) && ts >= _nowMs - AUTO_SEED_MAX_AGE_MS; };
      const toSeed = ((freshItems || []) as Record<string, unknown>[]).filter((i) => newKeys.has(String(i.type) + '|' + String(i.source_external_id)) && defByType[String(i.type)] && _recentEnough(i.occurred_at));
      await mapPool(toSeed, 8, (i) => seedTouches(supabase, String(i.id), defByType[String(i.type)], franchiseInternalID));
      autoSeeded = toSeed.length;
    }

    // RECONCILE (auto-resolve): a WO-derived item that no longer matches the source has been handled in Vonigo —
    // an unconverted estimate got CONVERTED (label → 245/9975/9970, e.g. Prentice), a cancellation got rebooked, a
    // UCB got booked off the lane. The sync only UPSERTS current matches, so without this the stale row lingers as
    // "still needs follow-up". We close it to `resolved` (leaves the worklist; findable under All) and skip its open
    // touches. Scoped to the recent window for cancel/unconverted; UCB has no window (the lane is a backlog). SAFE
    // here because these types come from the reliable local mirror — no partial-Vonigo-failure risk. We NEVER touch
    // items the owner already closed, and we don't clobber notes. (Leads/cases come from Vonigo → not reconciled here.)
    let reconciled = 0;
    const winStartIso = new Date(dateStart * 1000).toISOString();
    for (const t of ['cancellation', 'unconverted_estimate', 'ucb'].filter(want)) {
      const seen = new Set(rows.filter((r) => r.type === t).map((r) => String(r.source_external_id)));
      let q = supabase.from('pipeline_items').select('id, source_external_id').eq('franchise_id', franchiseInternalID).eq('type', t).not('stage', 'in', '(won,lost,dismissed,resolved)');
      if (t !== 'ucb') q = q.gte('occurred_at', winStartIso);
      const { data: openItems } = await q;
      const gone = ((openItems || []) as Record<string, unknown>[]).filter((i) => !seen.has(String(i.source_external_id))).map((i) => String(i.id));
      if (gone.length) {
        await supabase.from('pipeline_items').update({ stage: 'resolved', updated_at: new Date().toISOString() }).in('id', gone);
        await supabase.from('pipeline_touches').update({ status: 'skipped' }).in('pipeline_item_id', gone).eq('status', 'scheduled');
        reconciled += gone.length;
      }
    }

    const counts: Record<string, number> = {};
    for (const t of ALL_TYPES) counts[t] = rows.filter((r) => r.type === t).length;
    return json({ success: true, franchiseID, window: { dateStart, dateEnd, days }, upserted, autoSeeded, reconciled, counts, reqId });
  } catch (e) {
    if (e instanceof VonigoUnavailable) return json(VONIGO_DOWN_BODY, 503);
    console.error(`[pipeline:${reqId}] error:`, (e as Error)?.stack || String(e));
    return json({ success: false, error: 'Could not sync the pipeline.', reqId }, 500);
  }
});
