// Supabase Edge Function: crewlogic-alert-health
//
// Catches the class of failure that hid #31's dead geofence alerts for 7 days (Aug 2026): a franchise's
// telematics arrival/exit events silently stop, and nothing notices. crewlogic-fn-health only detects
// GATEWAY 401s (the --no-verify-jwt regression); this monitor detects the APPLICATION-level breaks it can't:
//
//   SIGNAL 1 — AUTH-FAIL ("provider is posting but we're rejecting it"): reads telematics_webhook_health
//     (0090), which the webhooks upsert on every post. fail_streak >= 3 with a recent last_fail_at and no
//     newer last_ok_at = the provider IS posting but the token doesn't match (the exact Aug-5 #31 break).
//
//   SIGNAL 2 — SILENCE (catch-all): a franchise with telematics CONNECTED + job geofences created in the
//     last 24h (so trucks should be visiting) but ZERO geofence_alerts in 24h, and a history of firing.
//     Catches the cases the auth signal can't — the provider stopped posting, a URL got mangled, a cron died.
//
// Alerts on TRANSITION only (healthy->broken and back) via service_health + crewlogic-notify — one email per
// outage, not per cycle (same discipline as crewlogic-fn-health / crewlogic-vonigo-health). Recipient = owner.
//
// Deploy (DEV):  supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-alert-health --use-api --no-verify-jwt
// Cron: hourly -> net.http_post(this fn, Content-Type only, {}) — headerless, hence --no-verify-jwt.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ALERT_TO = ['charles.dennis@junkluggers.com'];
const SILENCE_HOURS = 24;   // owner-set: flag a franchise silent this long despite scheduled geofences
const AUTH_FAIL_MIN = 3;    // consecutive bad-token rejections before we call the webhook broken

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// service_health transition tracker — mirrors crewlogic-fn-health. Returns 'broke' | 'recovered' | null.
async function evalHealth(db: SupabaseClient, key: string, isUp: boolean, detail: string, now: string): Promise<'broke' | 'recovered' | null> {
  const { data: rows } = await db.from('service_health').select('service,is_up').eq('service', key).limit(1);
  const prev = rows && rows[0];
  const prevUp = prev ? prev.is_up : true; // assume healthy until proven broken
  const transitioned = prevUp !== isUp;
  if (!prev) {
    await db.from('service_health').insert({ service: key, is_up: isUp, fail_streak: 0, detail, last_checked: now, last_changed: now });
  } else {
    const patch: Record<string, unknown> = { is_up: isUp, detail, last_checked: now };
    if (transitioned) patch.last_changed = now;
    await db.from('service_health').update(patch).eq('service', key);
  }
  if (!transitioned) return null;
  return isUp ? 'recovered' : 'broke';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const db = createClient(SUPABASE_URL, SERVICE_KEY);
    const now = new Date();
    const nowIso = now.toISOString();
    const since = new Date(now.getTime() - SILENCE_HOURS * 3600_000).toISOString();

    // Franchises whose telematics is actively connected — the ones that SHOULD be receiving events.
    const { data: creds } = await db.from('telematics_credentials')
      .select('franchise_id, provider, franchises!inner(external_id)')
      .eq('is_active', true).eq('status', 'connected');

    const alertLines: string[] = [];
    const recoverLines: string[] = [];
    const checked: { ext: string; provider: string; silent: boolean; authBroken: boolean }[] = [];

    for (const c of (creds || []) as Record<string, unknown>[]) {
      const fid = String(c.franchise_id);
      const provider = String(c.provider);
      const ext = String((c.franchises as { external_id: string })?.external_id ?? fid);

      // ── SIGNAL 2: silence ──
      const { count: gfToday } = await db.from('job_geofences')
        .select('id', { count: 'exact', head: true })
        .eq('franchise_id', fid).eq('status', 'active').gt('created_at', since);
      const { data: lastAlertRow } = await db.from('geofence_alerts')
        .select('created_at').eq('franchise_id', fid)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      const lastAlert = lastAlertRow?.created_at ? new Date(String(lastAlertRow.created_at)) : null;
      // Broken = has jobs scheduled today (should be visited) + has fired before + silent for the window.
      const silent = (gfToday || 0) > 0 && lastAlert != null && lastAlert.getTime() < new Date(since).getTime();
      const silentDetail = silent
        ? `${gfToday} job geofences in last ${SILENCE_HOURS}h but no arrivals since ${lastAlert!.toISOString()}`
        : `ok (last alert ${lastAlert ? lastAlert.toISOString() : 'never'}, ${gfToday || 0} geofences ${SILENCE_HOURS}h)`;
      const t2 = await evalHealth(db, `alerts-silent:${ext}`, !silent, silentDetail, nowIso);
      if (t2 === 'broke') alertLines.push(`SILENT — Franchise #${ext} (${provider}): ${silentDetail}. Likely a telematics webhook/token break.`);
      if (t2 === 'recovered') recoverLines.push(`Franchise #${ext}: geofence alerts flowing again.`);

      // ── SIGNAL 1: auth-fail (provider posting but token rejected) ──
      const { data: h } = await db.from('telematics_webhook_health')
        .select('last_ok_at,last_fail_at,fail_streak').eq('franchise_id', fid).eq('provider', provider).maybeSingle();
      const lastFail = h?.last_fail_at ? new Date(String(h.last_fail_at)) : null;
      const lastOk = h?.last_ok_at ? new Date(String(h.last_ok_at)) : null;
      const authBroken = !!h && (Number(h.fail_streak) >= AUTH_FAIL_MIN)
        && lastFail != null && lastFail.getTime() > new Date(since).getTime()
        && (lastOk == null || lastOk.getTime() < lastFail.getTime());
      const authDetail = authBroken
        ? `${h!.fail_streak} consecutive bad-token rejections (last ${lastFail!.toISOString()}) — provider posting, token mismatch`
        : `ok (streak ${h?.fail_streak ?? 0}, last ok ${lastOk ? lastOk.toISOString() : 'never'})`;
      const t1 = await evalHealth(db, `alerts-auth:${ext}:${provider}`, !authBroken, authDetail, nowIso);
      if (t1 === 'broke') alertLines.push(`AUTH — Franchise #${ext} (${provider}): ${authDetail}. Re-sync the webhook secret.`);
      if (t1 === 'recovered') recoverLines.push(`Franchise #${ext} (${provider}): webhook auth recovered.`);

      checked.push({ ext, provider, silent, authBroken });
    }

    if (alertLines.length || recoverLines.length) {
      const lines: string[] = [];
      if (alertLines.length) { lines.push('*** TELEMATICS ALERTS NOT FIRING: ***'); alertLines.forEach(l => lines.push('  - ' + l)); }
      if (recoverLines.length) { lines.push(''); lines.push('RECOVERED:'); recoverLines.forEach(l => lines.push('  - ' + l)); }
      const subject = alertLines.length
        ? 'CrewLogic ALERT: a franchise\'s geofence alerts are not firing'
        : 'CrewLogic: geofence alerts recovered';
      await fetch(SUPABASE_URL + '/functions/v1/crewlogic-notify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, text: lines.join('\n'), bcc: ALERT_TO }),
      }).catch((e) => console.error('[alert-health] notify failed:', (e as Error).message));
    }

    return json({ success: true, checkedAt: nowIso, checked });
  } catch (e) {
    console.error('[alert-health] error:', (e as Error).message);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
