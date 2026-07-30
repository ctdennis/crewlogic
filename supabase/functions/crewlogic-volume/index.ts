// Supabase Edge Function: crewlogic-volume — FW-60 Phase 1 (AI volume estimator)
//
// Estimates each dispatch job's load VOLUME (cubic yards) from its Vonigo customer-situation summary
// + item list, so the dispatch board can predict when a truck fills and needs to dump / swap a can.
//
// AUTH MODEL — matches crewlogic-assignments / -jobs: the app calls with the anon key and passes
// franchiseInternalID (= franchises.id UUID). This function uses the SERVICE role and scopes every
// query by that UUID. route_volume_estimates is service-role only (RLS, no policies).
//
// COST DISCIPLINE (owner: "AI only charges for jobs it hasn't seen"): estimates are cached in
// route_volume_estimates keyed by (franchise, service_date, wo_id) + desc_hash = hash(summary+items).
// estimateRoute AIs ONLY the jobs with no cached row OR a changed description; everything else is
// returned from cache for free. The client's "AI" button calls estimateRoute; re-pressing costs
// nothing unless a job is new or its description changed.
//
// Actions:
//   estimateRoute   { franchiseInternalID, serviceDate, truckCY?, tenantID?, jobs:[{woID,summary,items}] }
//                   -> { success, estimates:[{woID,low,high,confidence,actual,eoConverted,cached}] }
//   setActual       { franchiseInternalID, serviceDate, woID, actualCuyd|null, setBy? }  (per-segment slider)
//   setEoConverted  { franchiseInternalID, serviceDate, woID, converted:bool }
//
// Deploy (DEV): supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-volume --use-api --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { logUsage } from '../_shared/usage.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6'; // Sonnet-class — judgment on free-text descriptions (never Haiku)

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function str(v: unknown): string { return v == null ? '' : String(v).trim(); }
function db() { return createClient(SUPABASE_URL, SERVICE_KEY); }

// Stable FNV-1a hash of the volume-relevant text (summary + items). Deterministic across runs/machines
// so a cache row matches iff the description is byte-identical; any edit flips the hash → re-estimate.
function descHash(summary: string, items: string): string {
  const s = (summary || '').trim() + '\x1f' + (items || '').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

// One Anthropic call for a BATCH of jobs → Map<woID, {low,high,confidence}>. Cubic yards, absolute
// (not truck-relative) so the number is stable regardless of truck size; truckCY is passed only to
// anchor the model's sense of scale ("a full truck ≈ N cu yd").
async function aiEstimate(jobs: { woID: string; summary: string; items: string }[], truckCY: number): Promise<Map<string, { low: number; high: number; confidence: string }>> {
  const out = new Map<string, { low: number; high: number; confidence: string }>();
  if (!jobs.length) return out;
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const cap = truckCY > 0 ? truckCY : 16;
  const system = [
    'You estimate JUNK-REMOVAL load VOLUME in CUBIC YARDS for each job, from the customer-situation summary and the item list.',
    `A full truck is about ${cap} cubic yards. Typical single furniture items: sofa ~1.5, mattress+box ~1, fridge ~1, dresser ~1, desk ~0.7, TV ~0.3.`,
    'Give a LOW and a HIGH bound (a realistic range, not best/worst extremes) and a confidence.',
    'Confidence: "high" when the item list is explicit and complete; "medium" when partial; "low" when vague ("clear out the apartment", estimate-only, no counts).',
    'When the description is vague, widen the range and lower the confidence rather than guessing a point value.',
    'Respond with ONLY a JSON array, no prose: [{"woID":"...","low":<number>,"high":<number>,"confidence":"low|medium|high"}]. Numbers are cubic yards, low <= high.',
  ].join('\n');
  const userContent = JSON.stringify(jobs.map(j => ({ woID: j.woID, summary: j.summary, items: j.items })));
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, messages: [{ role: 'user', content: userContent }] }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[volume] Anthropic ${res.status} (request-id: ${res.headers.get('request-id') || 'n/a'}): ${body}`);
    throw new Error(`AI request failed (Anthropic ${res.status})`);
  }
  const result = await res.json();
  const text = (((result.content || [])[0] || {}).text || '').trim();
  const jsonStr = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let arr: any[] = [];
  try { arr = JSON.parse(jsonStr); } catch (_e) {
    const m = jsonStr.match(/\[[\s\S]*\]/); if (m) { try { arr = JSON.parse(m[0]); } catch (_e2) { arr = []; } }
  }
  for (const r of (Array.isArray(arr) ? arr : [])) {
    const wo = str(r.woID); if (!wo) continue;
    let low = Number(r.low), high = Number(r.high);
    if (!isFinite(low)) low = 0; if (!isFinite(high)) high = low;
    if (high < low) { const t = low; low = high; high = t; }
    const conf = ['low', 'medium', 'high'].includes(String(r.confidence)) ? String(r.confidence) : 'low';
    out.set(wo, { low, high, confidence: conf });
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405);

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = str(body.action) || 'estimateRoute';
  const franchiseInternalID = str(body.franchiseInternalID);
  const serviceDate = str(body.serviceDate);
  if (!franchiseInternalID) return json({ success: false, error: 'franchiseInternalID required' }, 400);
  if (!serviceDate) return json({ success: false, error: 'serviceDate required' }, 400);

  const sb = db();

  try {
    // ── setActual — persist the per-segment slider value (crew/ops override). null clears it. ──
    if (action === 'setActual') {
      const woID = str(body.woID);
      if (!woID) return json({ success: false, error: 'woID required' }, 400);
      const raw = body.actualCuyd;
      const actual = (raw == null || raw === '') ? null : Number(raw);
      if (actual != null && !isFinite(actual)) return json({ success: false, error: 'actualCuyd must be a number or null' }, 400);
      // NEVER write desc_hash here — on an existing row it would clobber the real estimate hash and
      // force a needless (and estimate-drifting) re-AI on the next estimateRoute. desc_hash is nullable,
      // so a brand-new actual-only row just leaves it NULL.
      const { error } = await sb.from('route_volume_estimates').upsert({
        franchise_id: franchiseInternalID, service_date: serviceDate, wo_id: woID,
        actual_cuyd: actual, actual_set_by: str(body.setBy) || null,
        actual_set_at: actual == null ? null : new Date().toISOString(),
      }, { onConflict: 'franchise_id,service_date,wo_id', ignoreDuplicates: false });
      if (error) { console.error('[volume] setActual failed:', error.message); return json({ success: false, error: 'could not save actual' }, 500); }
      return json({ success: true, woID, actual });
    }

    // ── setEoConverted — an estimate-only job the crew converted to a haul (now counts in fill). ──
    if (action === 'setEoConverted') {
      const woID = str(body.woID);
      if (!woID) return json({ success: false, error: 'woID required' }, 400);
      const converted = body.converted === true;
      const { error } = await sb.from('route_volume_estimates').upsert({
        franchise_id: franchiseInternalID, service_date: serviceDate, wo_id: woID,
        eo_converted: converted, // no desc_hash — see setActual note (don't clobber the estimate hash)
      }, { onConflict: 'franchise_id,service_date,wo_id', ignoreDuplicates: false });
      if (error) { console.error('[volume] setEoConverted failed:', error.message); return json({ success: false, error: 'could not save conversion' }, 500); }
      return json({ success: true, woID, converted });
    }

    // ── estimateRoute — AI only the new/changed jobs, return the whole route from cache+fresh. ──
    if (action === 'estimateRoute') {
      const jobsIn = Array.isArray(body.jobs) ? (body.jobs as Record<string, unknown>[]) : [];
      const truckCY = Number(body.truckCY) || 16;
      const tenantID = str(body.tenantID) || null;
      const jobs = jobsIn.map(j => ({ woID: str(j.woID), summary: str(j.summary), items: str(j.items) })).filter(j => j.woID);
      if (!jobs.length) return json({ success: true, serviceDate, estimates: [] });

      // Load any existing rows for this route's WOs in one query.
      const woIDs = jobs.map(j => j.woID);
      const { data: existing } = await sb.from('route_volume_estimates')
        .select('wo_id, low_cuyd, high_cuyd, confidence, desc_hash, actual_cuyd, eo_converted')
        .eq('franchise_id', franchiseInternalID).eq('service_date', serviceDate).in('wo_id', woIDs);
      const byWo = new Map<string, any>();
      for (const r of (existing || [])) byWo.set(String(r.wo_id), r);

      // Partition: which jobs need a fresh AI estimate (no row, or row lacks an estimate, or desc changed).
      const need: typeof jobs = [];
      for (const j of jobs) {
        const row = byWo.get(j.woID);
        const h = descHash(j.summary, j.items);
        const hasEstimate = row && row.low_cuyd != null && !!row.desc_hash;
        if (!hasEstimate || row.desc_hash !== h) need.push(j);
      }

      let fresh = new Map<string, { low: number; high: number; confidence: string }>();
      if (need.length) {
        fresh = await aiEstimate(need, truckCY);
        // Upsert fresh estimates (preserve any existing actual/eo by not overwriting those columns).
        for (const j of need) {
          const est = fresh.get(j.woID); if (!est) continue;
          const { error } = await sb.from('route_volume_estimates').upsert({
            franchise_id: franchiseInternalID, service_date: serviceDate, wo_id: j.woID,
            low_cuyd: est.low, high_cuyd: est.high, confidence: est.confidence, model: MODEL,
            desc_hash: descHash(j.summary, j.items), estimated_at: new Date().toISOString(),
          }, { onConflict: 'franchise_id,service_date,wo_id', ignoreDuplicates: false });
          if (error) console.error('[volume] upsert estimate failed:', j.woID, error.message);
          // Per-job usage log (owner: "per job the AI reads"). Best-effort; never blocks the estimate.
          await logUsage(sb, { tenant_id: tenantID, franchise_id: franchiseInternalID, event_type: 'route_volume_estimate', metadata: { wo_id: j.woID, service_date: serviceDate } });
        }
      }

      // Merge cache + fresh into the response.
      const estimates = jobs.map(j => {
        const est = fresh.get(j.woID);
        const row = byWo.get(j.woID);
        const low = est ? est.low : (row && row.low_cuyd != null ? Number(row.low_cuyd) : null);
        const high = est ? est.high : (row && row.high_cuyd != null ? Number(row.high_cuyd) : null);
        const confidence = est ? est.confidence : (row ? row.confidence : null);
        return {
          woID: j.woID, low, high, confidence,
          actual: row && row.actual_cuyd != null ? Number(row.actual_cuyd) : null,
          eoConverted: row ? (row.eo_converted === true) : false,
          cached: !est && low != null,
        };
      });
      return json({ success: true, serviceDate, model: MODEL, aiCalls: need.length, estimates });
    }

    return json({ success: false, error: 'unknown action: ' + action }, 400);
  } catch (e) {
    console.error('[volume] error:', (e as Error).message, (e as Error).stack);
    return json({ success: false, error: (e as Error).message || 'volume request failed' }, 500);
  }
});
