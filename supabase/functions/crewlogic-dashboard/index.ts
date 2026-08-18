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
import { vonigoJson } from '../_shared/vonigo.ts';

const VONIGO_BASE = 'https://junkluggers.vonigo.com/api/v1';

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

// ─────────────────────────── Vonigo INVOICED revenue ───────────────────────────
// The revenueThisWeek / revenueThisMonth KPIs are the franchise's INVOICED "Subtotal" total from
// Vonigo — its "Revenue Details Report by Invoice" basis (Subtotal = Price − Discount, PRE-tax) —
// summed over ACTIVE invoices whose ISSUED date falls in the window. This is real billed revenue,
// not the job-mirror's booked figure. Vonigo is READ-ONLY here (Retrieval only; no writes).
//
// Reconciled 2026-08-18 against #90's actual report — Aug 1–18 MTD = $41,486.50 across 51 active
// invoices — which fixed two parameters the way this data really behaves (NOT the values first
// assumed): (1) /data/Invoices/ requires method:"0" here (method:"1" returns "Data validation
// failed"); (2) the issued-date basis is dateMode:"1" — dateMode:"3" is a DIFFERENT date (returned
// 50 / $38,502.50, not the report's set). Subtotal is Field 949 (the numeric field whose active
// total matched $41,486.50 / 51 exactly; Field 947 is Price-before-discount, 709 is tax).
const F_INVOICE_SUBTOTAL = 949;
const INVOICE_DATE_MODE = '1'; // issued-date basis, verified against the Revenue Details report

interface VonigoField { fieldID: number; fieldValue: string | null; optionID?: number; }
interface VonigoInvoice { objectID: string; isActive: boolean | string; Fields?: VonigoField[]; }

// Parse a Vonigo money field ("813.46", "$1,234.50", "-50.0000") → number, or NaN.
function money(v: unknown): number { return Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); }
function isActiveInvoice(inv: VonigoInvoice): boolean { return String(inv.isActive).toLowerCase() === 'true'; }

// Resolve this franchise's Vonigo credentials (same lookup the sibling fns use: external franchiseID
// + tenant → franchise row → get_vonigo_credential RPC, with a direct-table fallback).
async function resolveVonigoCreds(db: DB, franchiseID: string, tenantID: string): Promise<{ vonigo_username: string; vonigo_md5: string } | null> {
  const { data: fr } = await db.from('franchises').select('id').eq('external_id', franchiseID).eq('tenant_id', tenantID).maybeSingle();
  const internalID = (fr as { id?: string } | null)?.id;
  if (!internalID) return null;
  // The Vonigo password (md5) lives in Supabase Vault; get_vonigo_credential(p_franchise_id) joins it out.
  const { data, error } = await db.rpc('get_vonigo_credential', { p_franchise_id: internalID });
  if (error) throw error;
  if (Array.isArray(data) && data.length > 0) return data[0] as { vonigo_username: string; vonigo_md5: string };
  return null;
}

// MD5 /security/login/ → securityToken (throws on failure; caller's try/catch → null KPI).
async function vonigoLogin(creds: { vonigo_username: string; vonigo_md5: string }): Promise<string> {
  const url = new URL(VONIGO_BASE + '/security/login/');
  url.searchParams.set('company', 'Vonigo');
  url.searchParams.set('userName', creds.vonigo_username);
  url.searchParams.set('password', creds.vonigo_md5);
  const auth = await vonigoJson(await fetch(url.toString()));
  if (auth.errNo !== 0 || !auth.securityToken) throw new Error(`vonigo_auth_failed:${auth.errMsg || 'no token'}`);
  return auth.securityToken as string;
}

// Page /data/Invoices/ (dateMode:3, isCompleteObject) for [startEpoch,endEpoch] and sum the Subtotal
// field over ACTIVE invoices. Loops until a short page (< pageSize). Read-only (Retrieval, method:"1").
async function sumInvoicedSubtotal(token: string, startEpoch: number, endEpoch: number): Promise<{ total: number; count: number }> {
  const pageSize = 100;
  let total = 0, count = 0, pageNo = 1;
  for (;;) {
    const data = await vonigoJson(await fetch(VONIGO_BASE + '/data/Invoices/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        securityToken: token, method: '0', pageNo: String(pageNo), pageSize: String(pageSize),
        sortMode: '1', sortDirection: '1', dateMode: INVOICE_DATE_MODE,
        dateStart: String(startEpoch), dateEnd: String(endEpoch), isCompleteObject: 'true',
      }),
    }));
    const invoices = (data.Invoices || []) as VonigoInvoice[];
    for (const inv of invoices) {
      if (!isActiveInvoice(inv)) continue;
      const v = money((inv.Fields || []).find((f) => f.fieldID === F_INVOICE_SUBTOTAL)?.fieldValue);
      if (Number.isFinite(v)) { total += v; count++; }
    }
    if (invoices.length < pageSize) break;
    pageNo++;
    if (pageNo > 200) { console.warn('[crewlogic-dashboard] invoice paging hit 200-page safety cap'); break; }
  }
  return { total: Math.round(total * 100) / 100, count };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const franchiseInternalID = str(body.franchiseInternalID);
    if (!franchiseInternalID) return json({ success: false, error: 'franchiseInternalID required' }, 400);
    const fid = franchiseInternalID;
    const franchiseID = str(body.franchiseID);
    const tenantID = str(body.tenantID);

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
    const monthStartISO = zonedToUtcISO(tz, tp.year, tp.month, 1, 0);  // for timestamptz (outages/recycling)

    // Vonigo invoice date windows — Vonigo's date fields use the naive (clock-as-UTC) convention, so
    // encode franchise-local midnights with Date.UTC of the local calendar parts (see _shared/tz.ts).
    // dateEnd = tomorrow-local-midnight so all of today's issued invoices are included (MTD "through now").
    const weekStartEpoch = Math.floor(weekStart.getTime() / 1000);
    const monthStartEpoch = Math.floor(Date.UTC(tp.year, tp.month - 1, 1, 0, 0, 0) / 1000);
    const endEpoch = Math.floor((todayUTC.getTime() + 86400000) / 1000);

    const nowMs = Date.now();
    const iso24h = new Date(nowMs - 24 * 3600000).toISOString();
    const iso30d = new Date(nowMs - 30 * 86400000).toISOString();
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
    // created30d — estimates started in the last 30 days (any non-deleted status).
    const created30d = await safe('estimates.created30d', async () =>
      count(await db.from('estimates').select('id', { count: 'exact', head: true })
        .eq('franchise_id', fid).neq('status', 'deleted').gte('created_at', iso30d)));
    // conversionRate30d — won / (all non-deleted) created in the last 30d.
    const conversionRate30d = await safe('estimates.conversionRate30d', async () => {
      const total = await count(await db.from('estimates').select('id', { count: 'exact', head: true })
        .eq('franchise_id', fid).neq('status', 'deleted').gte('created_at', iso30d));
      if (!total) return null;
      const won = await count(await db.from('estimates').select('id', { count: 'exact', head: true })
        .eq('franchise_id', fid).eq('status', 'won').gte('created_at', iso30d));
      return Math.round((won / total) * 1000) / 1000;
    });
    // Estimate VALUE split, last 30d. submitted = posted to Vonigo (real pipeline in the CRM);
    // draft = built in CrewLogic but not yet posted. Each query in its own guarded block → value AND
    // count fall to null together on failure, never breaking the response (never-suppress: full error
    // to console via safe()).
    let inVonigoValue30d: number | null = null, inVonigoCount30d: number | null = null;
    await safe('estimates.inVonigo30d', async () => {
      const { data, error } = await db.from('estimates').select('total_price')
        .eq('franchise_id', fid).eq('status', 'submitted').gte('created_at', iso30d);
      if (error) throw error;
      const rows = (data || []) as Record<string, unknown>[];
      inVonigoValue30d = Math.round(sumField(rows, 'total_price') * 100) / 100;
      inVonigoCount30d = rows.length;
      return null;
    });
    let crewlogicValue30d: number | null = null, crewlogicCount30d: number | null = null;
    await safe('estimates.crewlogic30d', async () => {
      const { data, error } = await db.from('estimates').select('total_price')
        .eq('franchise_id', fid).eq('status', 'draft').gte('created_at', iso30d);
      if (error) throw error;
      const rows = (data || []) as Record<string, unknown>[];
      crewlogicValue30d = Math.round(sumField(rows, 'total_price') * 100) / 100;
      crewlogicCount30d = rows.length;
      return null;
    });

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
    // revenueThisWeek / revenueThisMonth = Vonigo INVOICED Subtotal (real billed revenue; see the
    // F_INVOICE_SUBTOTAL note above), NOT the job-mirror booked figure. ops.bookedRevenueToday stays
    // the mirror's booked total — only these two switch basis. One Vonigo login, reused for both
    // windows. On ANY Vonigo failure (down/slow/auth) BOTH stay null: the dashboard must never break
    // when Vonigo is unavailable. Full error → console; only null reaches the client.
    let revenueThisWeek: number | null = null;
    let revenueThisMonth: number | null = null;
    await safe('money.invoicedRevenue', async () => {
      const creds = await resolveVonigoCreds(db, franchiseID, tenantID);
      if (!creds) { console.warn(`[crewlogic-dashboard] no Vonigo creds for franchise ${franchiseID}; invoiced revenue → null`); return null; }
      const token = await vonigoLogin(creds);
      revenueThisWeek = (await sumInvoicedSubtotal(token, weekStartEpoch, endEpoch)).total;
      revenueThisMonth = (await sumInvoicedSubtotal(token, monthStartEpoch, endEpoch)).total;
      return null;
    });
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
      estimates: { created30d, conversionRate30d, inVonigoValue30d, inVonigoCount30d, crewlogicValue30d, crewlogicCount30d },
      bizdev: { pipelineEstimates, newLeads24h, cancellationsToReschedule, pipelineTotalValue },
      money: { revenueThisWeek, revenueThisMonth, recyclingCollectedMtd },
      reliability: { vonigoUp, vonigoOutagesThisMonth, vonigoDowntimeSecThisMonth },
    });
  } catch (e) {
    console.error('[crewlogic-dashboard] fatal:', (e as Error)?.stack || String(e));
    return json({ success: false, error: 'dashboard_failed' }, 500);
  }
});
