// Supabase Edge Function: crewlogic-fn-health
//
// Guards against the recurring --no-verify-jwt regression: a plain `functions deploy` silently omits
// the flag, flipping verify_jwt ON, and the Supabase gateway then 401s the SIGNATURE-ONLY POSTs from
// Motive/Linxup — geofence events are dropped fleet-wide and nobody notices for days (owner found a
// Saturday metal-recycler stop unrecorded, 2026-08-03).
//
// This cron probes each must-be-public WEBHOOK with an unsigned POST and classifies the response:
//   - GATEWAY-BLOCKED (verify_jwt ON): HTTP 401 whose BODY is the gateway's ("Invalid JWT" / "Missing
//     authorization"). This is the failure we page on.
//   - OPEN (healthy): the FUNCTION's own response — e.g. motive → {"error":"missing signature"},
//     linxup → {"error":"unknown franchise"} — or any 2xx. The webhook ran, so the gateway is open.
// Status code ALONE can't tell these apart (a signature-checking webhook returns its own 401), so we
// key on the BODY (the mistake made during the 2026-08-03 diagnosis).
//
// Only WEBHOOKS are probed — they reject an unsigned ping with NO side effect. The cron functions
// (photo-sweep, signs-lifecycle) are NOT probed here because an unsigned POST would EXECUTE them; add
// them later behind a {healthPing:true} early-return if desired.
//
// Alerts on TRANSITION only (open→blocked and back), via service_health (migration 0065/0069) +
// crewlogic-notify — same discipline as crewlogic-vonigo-health (one email per outage, not per cycle).
//
// Deploy (DEV):  supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-fn-health --use-api --no-verify-jwt
// Cron: every 10 min -> net.http_post(this fn, Content-Type only, {}) — headerless, hence --no-verify-jwt.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ALERT_TO = ['charles.dennis@junkluggers.com'];

// Must-be-public webhooks (safe to probe: they reject an unsigned ping before doing any work).
const WEBHOOKS = ['crewlogic-motive-webhook', 'crewlogic-linxup-webhook'];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// 'open' = gateway open (webhook ran); 'blocked' = gateway verify_jwt 401; 'unknown' = network/probe error.
async function probe(fn: string): Promise<{ state: 'open' | 'blocked' | 'unknown'; detail: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(SUPABASE_URL + '/functions/v1/' + fn, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    clearTimeout(t);
    const body = (await r.text()).slice(0, 300);
    // Gateway auth-reject: 401 whose BODY names the JWT/authorization (NOT the function's own error).
    const gateway = r.status === 401 && /invalid jwt|missing authorization|jwt is required|not authorized/i.test(body);
    return gateway ? { state: 'blocked', detail: 'gateway 401: ' + body.slice(0, 80) } : { state: 'open', detail: 'HTTP ' + r.status };
  } catch (e) {
    return { state: 'unknown', detail: 'probe error: ' + String((e as Error).message).slice(0, 60) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const db = createClient(SUPABASE_URL, SERVICE_KEY);
    const now = new Date().toISOString();
    const results: { fn: string; state: string; detail: string; transitioned: boolean }[] = [];
    const nowBlocked: string[] = [];
    const nowRecovered: string[] = [];

    for (const fn of WEBHOOKS) {
      const key = 'fn:' + fn;
      const p = await probe(fn);
      if (p.state === 'unknown') { results.push({ fn, state: p.state, detail: p.detail, transitioned: false }); continue; } // don't flip state on a probe blip

      const isUp = p.state === 'open';
      const { data: rows } = await db.from('service_health').select('service,is_up').eq('service', key).limit(1);
      const prev = rows && rows[0];
      const prevUp = prev ? prev.is_up : true; // assume healthy until proven blocked
      const transitioned = prevUp !== isUp;

      if (!prev) {
        await db.from('service_health').insert({ service: key, is_up: isUp, fail_streak: 0, detail: p.detail, last_checked: now, last_changed: now });
      } else {
        const patch: Record<string, unknown> = { is_up: isUp, detail: p.detail, last_checked: now };
        if (transitioned) patch.last_changed = now;
        await db.from('service_health').update(patch).eq('service', key);
      }
      if (transitioned && !isUp) nowBlocked.push(fn);
      if (transitioned && isUp) nowRecovered.push(fn);
      results.push({ fn, state: p.state, detail: p.detail, transitioned });
    }

    if (nowBlocked.length || nowRecovered.length) {
      const lines: string[] = [];
      if (nowBlocked.length) {
        lines.push('*** GATEWAY-BLOCKED (verify_jwt is ON — signature-only callers are being 401d): ***');
        nowBlocked.forEach((f) => lines.push('  - ' + f));
        lines.push('');
        lines.push('IMPACT: Motive/Linxup POSTs are rejected at the gateway, so geofence truck events are being DROPPED (unrecoverable — providers do not resend).');
        lines.push('FIX: redeploy WITH the flag -> supabase functions deploy --project-ref ozfkpxyachigfpcmvekz <fn> --use-api --no-verify-jwt');
      }
      if (nowRecovered.length) { lines.push(''); lines.push('RECOVERED (gateway open again):'); nowRecovered.forEach((f) => lines.push('  - ' + f)); }
      const subject = nowBlocked.length ? 'CrewLogic ALERT: webhook gateway BLOCKED — geofence events dropping' : 'CrewLogic: webhook gateway recovered';
      await fetch(SUPABASE_URL + '/functions/v1/crewlogic-notify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, text: lines.join('\n'), bcc: ALERT_TO }),
      }).catch((e) => console.error('[fn-health] notify failed:', (e as Error).message));
    }

    return json({ success: true, checkedAt: now, results });
  } catch (e) {
    console.error('[fn-health] error:', (e as Error).message);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
