// Supabase Edge Function: crewlogic-trucks (v2.0 — per-franchise)
// Returns current truck GPS locations for a franchise, normalized to data.trucks.
//
// PRIMARY path (per-franchise): caller passes ?franchiseID=<uuid> (or POST body
// { franchiseID }). We resolve that franchise's provider + token from Vault via
// the service-role-only RPC get_telematics_credential(), then pull from the
// matching provider. The token NEVER reaches the client.
//
// LEGACY/TEST fallback: if no franchiseID is given, fall back to the old global
// behavior — ?provider=motive|linxup using the global MOTIVE_API_KEY /
// LINXUP_API_KEY secrets. Kept so the existing Route-Optimizer consumer and ad
// hoc testing keep working during the transition.
//
// SECRETS / ENV:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — injected; used to call the RPC
//   MOTIVE_API_KEY, LINXUP_API_KEY          — legacy fallback only
//
// Normalized response (unchanged shape):
//   { success, provider, trucks: [ { number, name, lat, lon, speed, heading,
//                                    status, lastUpdate, make, model, year, vin, desc } ] }

import { fetchTrucks } from "../_shared/telematics.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Resolve a franchise's provider + decrypted token via the service-role RPC.
async function getFranchiseCredential(
  franchiseID: string,
): Promise<{ provider: string; token: string } | null> {
  const res = await fetch(SUPABASE_URL + "/rest/v1/rpc/get_telematics_credential", {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_franchise_id: franchiseID }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error(`[crewlogic-trucks] get_telematics_credential ${res.status}: ${txt.slice(0, 200)}`);
    return null;
  }
  const rows = await res.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return { provider: String(rows[0].provider || ""), token: String(rows[0].token || "") };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Parse inputs from query string and/or POST body.
  const url = new URL(req.url);
  let franchiseID = url.searchParams.get("franchiseID") || "";
  let provider = url.searchParams.get("provider") || "";
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    franchiseID = franchiseID || String((body as { franchiseID?: string }).franchiseID || "");
    provider = provider || String((body as { provider?: string }).provider || "");
  }

  try {
    // PRIMARY: per-franchise resolution
    if (franchiseID) {
      const cred = await getFranchiseCredential(franchiseID);
      if (!cred || !cred.provider || !cred.token) {
        return jsonResponse(
          { success: false, error: "No telematics provider configured for this franchise." },
          404,
        );
      }
      const result = await fetchTrucks(cred.provider, cred.token);
      return jsonResponse(result, result.success ? 200 : 502);
    }

    // LEGACY/TEST fallback: global env secrets by provider
    provider = (provider || "motive").toLowerCase();
    const envToken =
      provider === "linxup" ? Deno.env.get("LINXUP_API_KEY") : Deno.env.get("MOTIVE_API_KEY");
    if (!envToken) {
      return jsonResponse(
        { success: false, error: `${provider.toUpperCase()}_API_KEY not configured` },
        500,
      );
    }
    const result = await fetchTrucks(provider, envToken);
    return jsonResponse(result, result.success ? 200 : 502);
  } catch (e) {
    const err = e as Error;
    console.error("[crewlogic-trucks] error:", err?.message || err);
    return jsonResponse({ success: false, error: err.message || "Internal error" }, 500);
  }
});
