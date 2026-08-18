// Supabase Edge Function: crewlogic-dashboard (read-only) — desktop KPI rollup.
//
// Returns ONE JSON of rollup KPIs so the desktop dashboard makes a single call.
//   POST { franchiseID, franchiseInternalID, tenantID }
//
// AUTH MODEL — matches crewlogic-jobs / crewlogic-settings: the app authenticates most users
// (Google) with a CUSTOM session that has no Supabase Auth JWT, so it calls edge functions with
// the anon key and passes the franchise it resolved at login. This function therefore uses the
// SERVICE role and scopes every query by the caller-supplied franchiseInternalID. (Same SEC
// follow-up as the sibling read functions: verify the franchise server-side once auth unifies.)
//
// RESILIENCE — every KPI is computed in its own guarded block. On ANY single failure we set that
// value to null and console.error the full error; we NEVER fail the whole response for one KPI
// (never-suppress-errors: full error to console; no-internals-to-client: only null reaches the
// client). Any KPI that cannot be mapped to real data is null — never fabricated.
//
// TIME ZONES — all "today / this week / this month" boundaries resolve the FRANCHISE's own IANA
// zone via _shared/tz.ts (never hardcode Eastern). #90 is America/New_York.
//
// Deploy: bash supabase/dev-setup/deploy-fn.sh crewlogic-dashboard dev   (never a raw deploy)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveTimezone, todayPartsInTz, DEFAULT_TZ } from '../_shared/tz.ts';

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
function pad2(n: number): string { return String(n).padStart(2, '0'); }
function ymd(d: Date): string { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }

// The tz offset (ms) for `tz` at instant `date`. Used to turn a franchise-local wall-clock moment
// into the correct UTC instant (DST-safe).
function tzOffsetMs(tz: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(date)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  // 'hour' can come back as 24 for midnight in some runtimes — normalize.
  const hour = p.hour === 24 ? 0 : p.hour;
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, hour, p.minute, p.second);
  return asUTC - date.getTime();
}
// The UTC instant (ISO) of franchise-local (y,mo,d h:00) — for timestamptz comparisons on calendar boundaries.
function zonedToUtcISO(tz: string, y: number, mo: number, d: number, h = 0): string {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, 0, 0));
  const off = tzOffsetMs(tz, guess);
  return new Date(guess.getTime() - off).toISOString();
}

type DB = ReturnType<typeof createClient>;

// Run one KPI block; on ANY failure log the full error server-side and yield null (never throw).
async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); }
  catch (e) { console.error(`[crewlogic-dashboard] KPI '${label}' failed:`, (e as Error)?.stack || String(e)); return null; }
}
// Exact head count with franchise-scoped errors surfaced.
async function count(q: { count: number | null; error: unknown }): Promise<number> {
  if (q.error) throw q.error;
  return q.count || 0;
}
function sumField(rows: Record<string, unknown>[] | null, field: string): number {
  let s = 0;
  for (const r of rows || []) { const v = Number(r[field]); if (Number.isFinite(v)) s += v; }
  return s;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const franchiseInternalID = str(body.franchiseInternalID);
    if (!franchiseInternalID) return json({ success: false, error: 'franchiseInternalID required' }, 400);
    const fid = franchiseInternalID;

    const db: DB = createClient(SUPABASE_URL, SERVICE_KEY);

    // ── Resolve the franchise's IANA zone (never fail the response over this — default Eastern). ──
    let tz = DEFAULT_TZ;
    try {
      const { data: fr } = await db.from('franchises').select('cost_settings').eq('id', fid).maybeSingle();
      tz = resolveTimezone((fr as Record<string, unknown> | null)?.cost_settings);
    } catch (e) {
      console.error('[crewlogic-dashboard] tz resolve failed, defaulting to', DEFAULT_TZ, ':', (e as Error).message);
    }

    // Calendar boundaries in the franchise's own zone.
    const tp = todayPartsInTz(tz);                                   // { year, month, day } now-in-tz
    const todayUTC = new Date(Date.UTC(tp.year, tp.month - 1, tp.day));
    const todayStr = ymd(todayUTC);
    const dow = todayUTC.getUTCDay();                                // 0=Sun … 6=Sat (Sunday-start week)
    const weekStart = new Date(todayUTC); weekStart.setUTCDate(todayUTC.getUTCDate() - dow);
    const weekEnd = new Date(weekStart); weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
    const weekStartStr = ymd(weekStart), weekEndStr = ymd(weekEnd);
    const monthStartStr = `${tp.year}-${pad2(tp.month)}-01`;
    const monthEnd = new Date(Date.UTC(tp.year, tp.month, 0));       // day 0 of next month = last day this month
    const monthEndStr = ymd(monthEnd);
    const monthStartISO = zonedToUtcISO(tz, tp.year, tp.month, 1, 0);  // for timestamptz (outages/recycling)

    const nowMs = Date.now();
    const iso7d = new Date(nowMs - 7 * 86400000).toISOString();
    const iso24h = new Date(nowMs - 24 * 3600000).toISOString();
    const iso30d = new Date(nowMs - 30 * 86400000).toISOString();
    const iso90d = new Date(nowMs - 90 * 86400000).toISOString();
    const CLOSED = '(won,lost,dismissed,resolved)';

    // ══════════════════════════ OPS ══════════════════════════
    // jobsToday — non-cancelled appointments scheduled today (franchise TZ).
    const jobsToday = await safe('ops.jobsToday', async () =>
      count(await db.from('job_appointments').select('id', { count: 'exact', head: true })
        .eq('franchise_id', fid).eq('scheduled_date', todayStr).neq('status', 'cancelled')));
    // jobsCompletedToday — status 'done' today.
    const jobsCompletedToday = await safe('ops.jobsCompletedToday', async () =>
      count(await db.from('job_appointments').select('id', { count: 'exact', head: true })
        .eq('franchise_id', fid).eq('scheduled_date', todayStr).eq('status', 'done')));
    // jobsRemainingToday — non-cancelled minus completed.
    const jobsRemainingToday = (jobsToday != null && jobsCompletedToday != null)
      ? Math.max(0, jobsToday - jobsCompletedToday) : null;
    // activeRoutesToday + bookedRevenueToday — from the source snapshot joined to today's non-cancelled appts.
    let activeRoutesToday: number | null = null, bookedRevenueToday: number | null = null;
    const opsSnap = await safe('ops.snapshotToday', async () => {
      const { data, error } = await db.from('job_source_snapshot')
        .select('import_total, route_name, job_appointments!inner(scheduled_date, status)')
        .eq('franchise_id', fid)
        .eq('job_appointments.scheduled_date', todayStr)
        .neq('job_appointments.status', 'cancelled');
      if (error) throw error;
      return (data || []) as Record<string, unknown>[];
    });
    if (opsSnap) {
      const routes = new Set<string>();
      for (const r of opsSnap) { const rn = str(r.route_name); if (rn) routes.add(rn); }
      activeRoutesToday = routes.size;
      bookedRevenueToday = Math.round(sumField(opsSnap, 'import_total') * 100) / 100;
    }

    // ══════════════════════════ ESTIMATES ══════════════════════════
    const created7d = await safe('estimates.created7d', async () =>
      count(await db.from('estimates').select('id', { count: 'exact', head: true })
        .eq('franchise_id', fid).neq('status', 'deleted').gte('created_at', iso7d)));
    // conversionRate30d — won / (all non-deleted) created in the last 30d.
    const conversionRate30d = await safe('estimates.conversionRate30d', async () => {
      const total = await count(await db.from('estimates').select('id', { count: 'exact', head: true })
        .eq('franchise_id', fid).neq('status', 'deleted').gte('created_at', iso30d));
      if (!total) return null;
      const won = await count(await db.from('estimates').select('id', { count: 'exact', head: true })
        .eq('franchise_id', fid).eq('status', 'won').gte('created_at', iso30d));
      return Math.round((won / total) * 1000) / 1000;
    });
    // avgTicket — mean total_price of won (booked) estimates over the last 90d; null if none.
    const avgTicket = await safe('estimates.avgTicket', async () => {
      const { data, error } = await db.from('estimates').select('total_price')
        .eq('franchise_id', fid).eq('status', 'won').gte('created_at', iso90d);
      if (error) throw error;
      const vals = (data || []).map((r: Record<string, unknown>) => Number(r.total_price)).filter((n) => Number.isFinite(n) && n > 0);
      if (!vals.length) return null;
      return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
    });
    // avgMargin — mean saved margin_pct (0..100) over the last 30d, normalized to 0..1; null if none.
    const avgMargin = await safe('estimates.avgMargin', async () => {
      const { data, error } = await db.from('estimate_costings').select('margin_pct')
        .eq('franchise_id', fid).gte('created_at', iso30d);
      if (error) throw error;
      const vals = (data || []).map((r: Record<string, unknown>) => Number(r.margin_pct)).filter((n) => Number.isFinite(n));
      if (!vals.length) return null;
      return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length / 100) * 1000) / 1000;
    });
    const openDrafts = await safe('estimates.openDrafts', async () =>
      count(await db.from('estimates').select('id', { count: 'exact', head: true })
        .eq('franchise_id', fid).eq('status', 'draft')));

    // ══════════════════════════ BIZDEV (pipeline) ══════════════════════════
    const pipelineEstimates = await safe('bizdev.pipelineEstimates', async () =>
      count(await db.from('pipeline_items').select('id', { count: 'exact', head: true })
        .eq('franchise_id', fid).eq('type', 'unconverted_estimate').not('stage', 'in', CLOSED)));
    const newLeads24h = await safe('bizdev.newLeads24h', async () =>
      count(await db.from('pipeline_items').select('id', { count: 'exact', head: true })
        .eq('franchise_id', fid).eq('type', 'lead').gte('occurred_at', iso24h)));
    const cancellationsToReschedule = await safe('bizdev.cancellationsToReschedule', async () =>
      count(await db.from('pipeline_items').select('id', { count: 'exact', head: true })
        .eq('franchise_id', fid).eq('type', 'cancellation').not('stage', 'in', CLOSED)));
    // pipelineTotalValue — sum of open items' amount.
    const pipelineTotalValue = await safe('bizdev.pipelineTotalValue', async () => {
      const { data, error } = await db.from('pipeline_items').select('amount')
        .eq('franchise_id', fid).not('stage', 'in', CLOSED);
      if (error) throw error;
      return Math.round(sumField((data || []) as Record<string, unknown>[], 'amount') * 100) / 100;
    });

    // ══════════════════════════ MONEY ══════════════════════════
    // Booked revenue = sum of import_total over non-cancelled appts scheduled within the range (franchise TZ).
    const revenueForRange = async (fromStr: string, toStr: string) => {
      const { data, error } = await db.from('job_source_snapshot')
        .select('import_total, job_appointments!inner(scheduled_date, status)')
        .eq('franchise_id', fid)
        .gte('job_appointments.scheduled_date', fromStr)
        .lte('job_appointments.scheduled_date', toStr)
        .neq('job_appointments.status', 'cancelled');
      if (error) throw error;
      return Math.round(sumField((data || []) as Record<string, unknown>[], 'import_total') * 100) / 100;
    };
    const revenueThisWeek = await safe('money.revenueThisWeek', () => revenueForRange(weekStartStr, weekEndStr));
    const revenueThisMonth = await safe('money.revenueThisMonth', () => revenueForRange(monthStartStr, monthEndStr));
    // recyclingCollectedMtd — sum of settled visit_settlements this month (a row exists only when collected).
    const recyclingCollectedMtd = await safe('money.recyclingCollectedMtd', async () => {
      const { data, error } = await db.from('visit_settlements').select('amount')
        .eq('franchise_id', fid).gte('settled_at', monthStartISO);
      if (error) throw error;
      return Math.round(sumField((data || []) as Record<string, unknown>[], 'amount') * 100) / 100;
    });

    // ══════════════════════════ RELIABILITY (global) ══════════════════════════
    const vonigoUp = await safe('reliability.vonigoUp', async () => {
      const { data, error } = await db.from('service_health').select('is_up').eq('service', 'vonigo').maybeSingle();
      if (error) throw error;
      return data ? Boolean((data as { is_up: boolean }).is_up) : null;
    });
    const vonigoOutagesThisMonth = await safe('reliability.vonigoOutagesThisMonth', async () =>
      count(await db.from('vonigo_outages').select('id', { count: 'exact', head: true })
        .eq('service', 'vonigo').gte('started_at', monthStartISO)));
    // Downtime this month = overlap of each outage window [started, ended||now] with [monthStart, now].
    const vonigoDowntimeSecThisMonth = await safe('reliability.vonigoDowntimeSecThisMonth', async () => {
      const { data, error } = await db.from('vonigo_outages')
        .select('started_at, ended_at')
        .eq('service', 'vonigo')
        .or(`started_at.gte.${monthStartISO},ended_at.is.null`);
      if (error) throw error;
      const monthStartMs = Date.parse(monthStartISO);
      let sec = 0;
      for (const o of (data || []) as Record<string, unknown>[]) {
        const start = Date.parse(str(o.started_at));
        if (!Number.isFinite(start)) continue;
        const end = o.ended_at ? Date.parse(str(o.ended_at)) : nowMs;
        const lo = Math.max(start, monthStartMs), hi = Math.min(end, nowMs);
        if (hi > lo) sec += Math.floor((hi - lo) / 1000);
      }
      return sec;
    });

    return json({
      success: true,
      generatedAt: new Date().toISOString(),
      franchiseTz: tz,
      ops: { jobsToday, activeRoutesToday, bookedRevenueToday, jobsCompletedToday, jobsRemainingToday },
      estimates: { created7d, conversionRate30d, avgTicket, avgMargin, openDrafts },
      bizdev: { pipelineEstimates, newLeads24h, cancellationsToReschedule, pipelineTotalValue },
      money: { revenueThisWeek, revenueThisMonth, recyclingCollectedMtd },
      reliability: { vonigoUp, vonigoOutagesThisMonth, vonigoDowntimeSecThisMonth },
    });
  } catch (e) {
    console.error('[crewlogic-dashboard] fatal:', (e as Error)?.stack || String(e));
    return json({ success: false, error: 'dashboard_failed' }, 500);
  }
});
