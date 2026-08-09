// Supabase Edge Function: crewlogic-ny-photo (v1.0) — public image proxy for Estimate Costing.
//
// Vonigo photo download URLs (…/api/Download/?<GUID>#<name>) serve `application/octet-stream`, which browsers
// won't reliably render in <img>, and they're cross-origin (canvas taint blocks client-side downscale). This
// proxy fetches ONE such URL and re-serves the bytes as image/jpeg with permissive CORS, so the client can both
// display the photo and canvas-downscale it before sending to the AI (crewlogic-ny-estimate group/quantify).
//
// Public (no JWT) because it's an <img> src / fetch target. SSRF-guarded: it only proxies
// https://junkluggers.vonigo.com/api/Download/... URLs (the same self-authenticating, already-public GUID links).
//
// Deploy (must be public): bash supabase/dev-setup/deploy-fn.sh crewlogic-ny-photo dev   (prod gated)
//
// GET /crewlogic-ny-photo?u=<url-encoded Vonigo Download URL>  →  image/jpeg bytes

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const ALLOWED_PREFIX = 'https://junkluggers.vonigo.com/api/Download';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: CORS });

  const u = new URL(req.url).searchParams.get('u') || '';
  if (!u.startsWith(ALLOWED_PREFIX)) {
    return new Response('Forbidden target', { status: 400, headers: CORS });
  }
  try {
    const upstream = await fetch(u);
    if (!upstream.ok) return new Response('Upstream ' + upstream.status, { status: 502, headers: CORS });
    const buf = await upstream.arrayBuffer();
    return new Response(buf, {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' },
    });
  } catch (_e) {
    return new Response('Fetch failed', { status: 502, headers: CORS });
  }
});
