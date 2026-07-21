// Supabase Edge Function: crewlogic-promos
//
// Look up Vonigo promotion (coupon) codes so anyone taking a call can answer "what does this
// coupon actually do, and can I honour it?" without opening Vonigo.
//
// READ ONLY BY CONSTRUCTION. Vonigo's /resources/promos/ method enum is Retrieval=1 / Edit=2 /
// Add=3 (per its own API doc). This function hardcodes '1' and '-1'; the method NEVER comes from
// the request, so no caller can turn a lookup into an Edit or an Add.
//
// Actions:
//   list    - every promo (method -1). Returns the full record per promo, so the picker can show
//             detail without a second round trip.
//   lookup  - one promo by code (method 1). Adds Franchises[] / ClientTypes[] opt-in data, which
//             the list call does NOT return — that is the "can I honour this" answer.
//
// MEASURED against live Vonigo 2026-07-21:
//   method -1                 -> errNo 0, key `Promos`, 226 records
//   method 1 + promo=<code>   -> errNo 0, key `Promo` (singular) + Franchises + ClientTypes
//   method 1, promo omitted   -> errNo -600 "Promo code value is not supplied." (-7612)
// So listing needs -1; there is no "method 1 with no code" list, which was the initial assumption.
//
// Deploy (DEV):
//   supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-promos --use-api --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const TENANT_ID = '946a4535-aa61-45b6-a6fb-9190ff546d41';
const VONIGO_BASE = 'https://junkluggers.vonigo.com/api/v1';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function supa() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

// Same resolution chain as crewlogic-dispatch: RPC, then RPC under alternate param names, then a
// direct table read. Kept identical deliberately — a promo lookup must not be the one place that
// resolves credentials differently.
async function vonigoAuth(franchiseID: string): Promise<{ token: string } | { error: string }> {
  const sb = supa();
  const { data: fr } = await sb.from('franchises').select('id').eq('external_id', franchiseID).eq('tenant_id', TENANT_ID).single();
  if (!fr) return { error: 'franchise not found: ' + franchiseID };
  let creds: any = null;
  const { data: cr } = await sb.rpc('get_vonigo_credential', { franchise_id_param: fr.id });
  if (cr && cr.length) creds = cr[0];
  if (!creds) {
    for (const p of ['p_franchise_id', 'franchise_id', 'franchiseid', 'fid']) {
      const a: Record<string, string> = {}; a[p] = fr.id;
      const r = await sb.rpc('get_vonigo_credential', a);
      if (!r.error && r.data && r.data.length) { creds = r.data[0]; break; }
    }
  }
  if (!creds) {
    const { data: d } = await sb.from('vonigo_credentials').select('vonigo_username, vonigo_md5').eq('franchise_id', fr.id).limit(1);
    if (d && d.length) creds = d[0];
  }
  if (!creds) return { error: 'no Vonigo credentials for franchise ' + franchiseID };
  const u = new URL(VONIGO_BASE + '/security/login/');
  u.searchParams.set('company', 'Vonigo');
  u.searchParams.set('userName', creds.vonigo_username);
  u.searchParams.set('password', creds.vonigo_md5);
  const a = await (await fetch(u.toString())).json();
  if (a.errNo !== 0 || !a.securityToken) return { error: 'Vonigo auth failed: ' + (a.errMsg || 'no token') };
  return { token: a.securityToken };
}

const vpost = (token: string, path: string, payload: unknown) =>
  fetch(VONIGO_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ securityToken: token, ...(payload as Record<string, unknown>) }),
  }).then((r) => r.json());

// Vonigo sends epochs as SECONDS in a string, and an empty string for "no end date".
function epochOrNull(v: unknown): number | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

// Normalise one Vonigo promo into the shape the UI renders.
//
// `usable` is computed, NOT taken from isActive. Vonigo returns isActive:true on promos whose
// promoEnd is years in the past (e.g. 10Listen19 ended 2019-12-30 and still reports active), so
// trusting isActive would tell someone on the phone to honour a long-dead coupon.
function shape(p: any) {
  const startMs = epochOrNull(p.promoStart);
  const endMs = epochOrNull(p.promoEnd);
  const now = Date.now();
  const notStarted = startMs != null && now < startMs;
  const expired = endMs != null && now > endMs;
  const disabled = p.isActive === false;
  return {
    promoID: p.promoID,
    code: p.promoCode || '',
    description: p.promoDescription || '',
    discount: typeof p.promoDiscount === 'number' ? p.promoDiscount : Number(p.promoDiscount || 0),
    measure: p.promoMeasure || '',                       // 'amount' | 'percent'
    // Must parse as a POSITIVE NUMBER. Vonigo's promoAmountIfMoreThen is free text and carries
    // junk in live data — 10PULLTAB returns a lone apostrophe ("'"), which a truthiness check
    // passes straight through and renders as "Minimum spend: $'". Anything non-numeric is treated
    // as no minimum, which is also how Vonigo behaves.
    minSpend: (() => {
      const raw = String(p.promoAmountIfMoreThen ?? '').trim();
      if (!raw) return null;
      const n = Number(raw.replace(/[$,]/g, ''));
      return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
    })(),
    startMs, endMs,
    isActiveRaw: p.isActive === true,
    // One word for the UI to colour on, and the reason, so a greyed-out row explains itself.
    usable: !disabled && !expired && !notStarted,
    state: disabled ? 'disabled' : notStarted ? 'not-started' : expired ? 'expired' : 'live',
    campaign: p.campaign || '',
    campaignID: p.campaignID ?? null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json().catch(() => ({} as any));
    const action = String(body.action || 'list');
    const franchiseID = String(body.franchiseID || '');
    if (!franchiseID) return json({ success: false, error: 'franchiseID required' }, 400);

    const auth = await vonigoAuth(franchiseID);
    if ('error' in auth) return json({ success: false, error: auth.error }, 502);
    const token = auth.token;

    if (action === 'list') {
      const r = await vpost(token, '/resources/promos/', { method: '-1' });
      if (r.errNo !== 0) {
        console.error('[promos] list failed:', r.errNo, r.errMsg, JSON.stringify(r.Errors || null));
        return json({ success: false, error: 'Vonigo error ' + r.errNo + ': ' + (r.errMsg || '') }, 502);
      }
      const all = (r.Promos || []).map(shape);
      // Live first, then by code — someone hunting a coupon almost always wants a current one,
      // and 226 rows is far too many to scan in Vonigo's own order.
      all.sort((a: any, b: any) =>
        (a.usable === b.usable ? 0 : a.usable ? -1 : 1) ||
        a.code.localeCompare(b.code, undefined, { sensitivity: 'base' }));
      return json({ success: true, count: all.length, liveCount: all.filter((p: any) => p.usable).length, promos: all });
    }

    if (action === 'lookup') {
      const code = String(body.promo || '').trim();
      if (!code) return json({ success: false, error: 'promo code required' }, 400);

      const r = await vpost(token, '/resources/promos/', { method: '1', promo: code });
      // -7601 "Promo does not exist" is a normal answer to "is this code real?", not a failure.
      // Returning 502 here would render as "lookup broken" when the truthful answer is "no such
      // coupon" — which is exactly what someone on the phone needs to hear.
      if (r.errNo !== 0) {
        const first = Array.isArray(r.Errors) && r.Errors.length ? r.Errors[0] : null;
        const notFound = first && first.errNo === -7601;
        return json({
          success: true, found: false, code,
          message: notFound ? 'No promo code "' + code + '" exists in Vonigo.'
                            : 'Vonigo error ' + r.errNo + ': ' + (r.errMsg || ''),
        });
      }

      const p = Array.isArray(r.Promo) && r.Promo.length ? r.Promo[0] : null;
      if (!p) return json({ success: true, found: false, code, message: 'No promo code "' + code + '" exists in Vonigo.' });

      // Resolve THIS franchise's participation server-side. The array carries every franchise in
      // the system (73 at time of writing), and scanning it is not the client's job.
      const fr = (r.Franchises || []).find((f: any) => String(f.franchiseID) === franchiseID) || null;
      const clientTypes = (r.ClientTypes || [])
        .filter((c: any) => c.isOptedOut === false)
        .map((c: any) => c.clientType);

      return json({
        success: true, found: true,
        promo: shape(p),
        // null = this franchise was not listed at all, which is different from "opted out".
        availableToYou: fr ? fr.isOptedOut === false : null,
        franchiseName: fr ? fr.franchiseName : null,
        optedInCount: (r.Franchises || []).filter((f: any) => f.isOptedOut === false).length,
        franchiseCount: (r.Franchises || []).length,
        clientTypes,
      });
    }

    return json({ success: false, error: 'unknown action: ' + action }, 400);
  } catch (e) {
    console.error('[promos] error:', (e as Error).message, (e as Error).stack);
    return json({ success: false, error: 'lookup failed' }, 500);
  }
});
