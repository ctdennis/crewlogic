// Supabase Edge Function: crewlogic-geofence-create (v0.1 — test/foundation)
// Creates a geofence in the franchise's telematics provider, server-side, using the
// token stored in Vault (resolved via the service-role-only RPC get_telematics_credential).
// The provider API key NEVER reaches the client.
//
// R1-test scope: MOTIVE circular geofence (POST /v1/geofences/circular). Linxup + polygon
// support come with the Round-2 geofence/wait-time work.
//
// Request body:
//   { franchiseID (internal uuid), name, category, address,
//     radius_in_meters, centre_lat, centre_lon, status?, description? }
// Response: { success, status, provider, motive } (raw provider response echoed back).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GOOGLE_KEY = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || Deno.env.get("GOOGLE_MAPS_API_KEY") || "";

// Rooftop-accurate forward geocode via Google (better than Census street-interpolation for a pin).
async function geocodeGoogle(address: string): Promise<{ lat: number; lon: number } | null> {
  if (!GOOGLE_KEY || !address) return null;
  try {
    const url = "https://maps.googleapis.com/maps/api/geocode/json?address=" +
      encodeURIComponent(address) + "&key=" + GOOGLE_KEY;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    const loc = data?.results?.[0]?.geometry?.location;
    if (loc && typeof loc.lat === "number" && typeof loc.lng === "number") {
      return { lat: loc.lat, lon: loc.lng };
    }
  } catch (e) {
    console.error("[geofence-create] geocode error:", (e as Error).message);
  }
  return null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Resolve a franchise's provider + decrypted token via the service-role RPC (same path crewlogic-trucks uses).
async function getFranchiseCredential(
  franchiseID: string,
): Promise<{ provider: string; token: string } | null> {
  const res = await fetch(SUPABASE_URL + "/rest/v1/rpc/get_telematics_credential", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({ p_franchise_id: franchiseID }),
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error(`[geofence-create] get_telematics_credential ${res.status}: ${txt.slice(0, 200)}`);
    return null;
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return { provider: String(rows[0].provider || ""), token: String(rows[0].token || "") };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 405);

  try {
    const body = await req.json();
    const franchiseID = String(body.franchiseID || "").trim();
    const name = String(body.name || "").trim();
    const category = String(body.category || "").trim();
    const address = String(body.address || "").trim();
    const radius_in_meters = Number(body.radius_in_meters);
    let centre_lat = Number(body.centre_lat);
    let centre_lon = Number(body.centre_lon);
    let geocodedVia = "client";
    const status = String(body.status || "active").trim();
    const description = String(body.description || "").trim();

    if (!franchiseID) return jsonResponse({ success: false, error: "franchiseID required" }, 400);
    if (!name) return jsonResponse({ success: false, error: "name required" }, 400);
    // Prefer a client-provided center; otherwise geocode the address via Google (rooftop-accurate).
    if ((!Number.isFinite(centre_lat) || !Number.isFinite(centre_lon)) && address) {
      const g = await geocodeGoogle(address);
      if (g) { centre_lat = g.lat; centre_lon = g.lon; geocodedVia = "google"; }
    }
    if (!Number.isFinite(centre_lat) || !Number.isFinite(centre_lon)) {
      return jsonResponse({ success: false, error: "centre_lat/centre_lon required (Google geocoding of the address returned nothing)" }, 400);
    }
    if (!Number.isFinite(radius_in_meters) || radius_in_meters <= 0) {
      return jsonResponse({ success: false, error: "radius_in_meters must be > 0" }, 400);
    }

    const cred = await getFranchiseCredential(franchiseID);
    if (!cred || !cred.provider || !cred.token) {
      return jsonResponse({ success: false, error: "No telematics provider connected for this franchise." }, 404);
    }
    if (cred.provider.toLowerCase() !== "motive") {
      return jsonResponse({ success: false, error: `Geofence create currently supports Motive only (franchise is ${cred.provider}).` }, 400);
    }

    const motiveRes = await fetch("https://api.gomotive.com/v1/geofences/circular", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "x-api-key": cred.token },
      body: JSON.stringify({ name, category, address, radius_in_meters, centre_lat, centre_lon, status, description }),
    });
    const motive = await motiveRes.json().catch(() => ({}));
    if (!motiveRes.ok) {
      console.error(`[geofence-create] Motive ${motiveRes.status}: ${JSON.stringify(motive).slice(0, 300)}`);
    }
    return jsonResponse({ success: motiveRes.ok, status: motiveRes.status, provider: "motive", geocodedVia, centre: { lat: centre_lat, lon: centre_lon }, motive });
  } catch (e) {
    const err = e as Error;
    console.error("[geofence-create] error:", err?.stack || err?.message || String(e));
    return jsonResponse({ success: false, error: "Geofence create failed." }, 500);
  }
});
