// Supabase Edge Function: crewlogic-geofence-create (v0.2 — Motive + Linxup)
// Creates/deletes a geofence in the franchise's ACTIVE telematics provider, server-side, using
// the token stored in Vault (resolved via the service-role-only RPC get_telematics_credential),
// with a legacy global-secret fallback (MOTIVE_API_KEY / LINXUP_API_KEY). The provider API key
// NEVER reaches the client.
//
// Providers:
//   - Motive: circular geofence via POST /v1/geofences/circular; delete via DELETE /v1/geofences/{id}.
//   - Linxup: circle geofence via POST /ibis/rest/api/v2/geofences (radius in MILES);
//             delete via DELETE /ibis/rest/api/v2/geofences/{geofenceUUID}. Bearer <token>.
//
// Request body (create):
//   { franchiseID (internal uuid), name, category, address,
//     radius_in_meters, centre_lat, centre_lon, status?, description? }
// Request body (delete): { action:'delete', franchiseID, geofence_id }
// Response: { success, status, provider, geofence_id, ... } — geofence_id is the NORMALIZED
//   provider id the sync stores + deletes by (Motive geofence.id / Linxup geofenceUUID).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GOOGLE_KEY = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || Deno.env.get("GOOGLE_MAPS_API_KEY") || "";
const LINXUP_GEO_BASE = "https://app02.linxup.com/ibis/rest/api/v2/geofences"; // Linxup ibis v2 geofence CRUD (Bearer <token>)

// Per-franchise telematics token, with the legacy global-secret fallback (mirrors crewlogic-trucks).
function tokenForProvider(provider: string, credToken: string): string {
  if (credToken) return credToken;
  const p = provider.toLowerCase();
  if (p === "linxup") return Deno.env.get("LINXUP_API_KEY") || "";
  if (p === "motive") return Deno.env.get("MOTIVE_API_KEY") || "";
  return "";
}

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

    // DELETE branch (for delete-on-exit + end-of-day sweep): { action:'delete', franchiseID, geofence_id }
    if (String(body.action || "") === "delete") {
      const delFranchiseID = String(body.franchiseID || "").trim();
      const geofenceId = body.geofence_id;
      if (!delFranchiseID) return jsonResponse({ success: false, error: "franchiseID required" }, 400);
      if (geofenceId === undefined || geofenceId === null || geofenceId === "") {
        return jsonResponse({ success: false, error: "geofence_id required" }, 400);
      }
      const delCred = await getFranchiseCredential(delFranchiseID);
      const delProvider = (delCred?.provider || "").toLowerCase();
      const delToken = tokenForProvider(delProvider, delCred?.token || "");
      if (!delProvider || !delToken) {
        return jsonResponse({ success: false, error: "No telematics credential for this franchise." }, 404);
      }
      if (delProvider === "linxup") {
        const lxDel = await fetch(LINXUP_GEO_BASE + "/" + encodeURIComponent(String(geofenceId)), {
          method: "DELETE", headers: { accept: "application/json", Authorization: `Bearer ${delToken}` },
        });
        const lxTxt = await lxDel.text();
        let lxParsed: unknown; try { lxParsed = JSON.parse(lxTxt); } catch { lxParsed = lxTxt.slice(0, 300); }
        if (!lxDel.ok) console.error(`[geofence-create] Linxup DELETE ${lxDel.status}: ${lxTxt.slice(0, 300)}`);
        return jsonResponse({ success: lxDel.ok, status: lxDel.status, action: "delete", provider: "linxup", geofence_id: geofenceId, linxup: lxParsed });
      }
      if (delProvider !== "motive") {
        return jsonResponse({ success: false, error: `Geofence delete unsupported for provider ${delProvider}.` }, 400);
      }
      const delRes = await fetch("https://api.gomotive.com/v1/geofences/" + encodeURIComponent(String(geofenceId)), {
        method: "DELETE",
        headers: { accept: "application/json", "x-api-key": delToken },
      });
      const delTxt = await delRes.text();
      let delParsed: unknown; try { delParsed = JSON.parse(delTxt); } catch { delParsed = delTxt; }
      if (!delRes.ok) console.error(`[geofence-create] Motive DELETE ${delRes.status}: ${delTxt.slice(0, 300)}`);
      return jsonResponse({ success: delRes.ok, status: delRes.status, action: "delete", provider: "motive", geofence_id: geofenceId, motive: delParsed });
    }

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
    const provider = (cred?.provider || "").toLowerCase();
    const token = tokenForProvider(provider, cred?.token || "");
    if (!provider || !token) {
      return jsonResponse({ success: false, error: "No telematics provider connected for this franchise." }, 404);
    }

    if (provider === "linxup") {
      // Linxup circle geofence — radius is in MILES (0.1 mi ≈ 160m); convert from the meters the sync passes.
      const radiusMiles = radius_in_meters / 1609.34;
      const lxRes = await fetch(LINXUP_GEO_BASE, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, type: "Circle", points: [{ latitude: centre_lat, longitude: centre_lon }], radius: radiusMiles, fenceGroup: "CurrentJob", color: "00ff00", status: "ACT" }),
      });
      const lx = await lxRes.json().catch(() => ({}));
      if (!lxRes.ok) console.error(`[geofence-create] Linxup ${lxRes.status}: ${JSON.stringify(lx).slice(0, 300)}`);
      const gid = (lx && (lx.geofenceUUID || lx.geofence_id)) || null; // Linxup returns geofenceUUID = the id we store + delete by
      return jsonResponse({ success: lxRes.ok, status: lxRes.status, provider: "linxup", geofence_id: gid, geocodedVia, centre: { lat: centre_lat, lon: centre_lon }, linxup: lx });
    }

    if (provider !== "motive") {
      return jsonResponse({ success: false, error: `Geofence create unsupported for provider ${provider}.` }, 400);
    }

    const motiveRes = await fetch("https://api.gomotive.com/v1/geofences/circular", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "x-api-key": token },
      body: JSON.stringify({ name, category, address, radius_in_meters, centre_lat, centre_lon, status, description }),
    });
    const motive = await motiveRes.json().catch(() => ({}));
    if (!motiveRes.ok) {
      console.error(`[geofence-create] Motive ${motiveRes.status}: ${JSON.stringify(motive).slice(0, 300)}`);
    }
    const motiveGid = (motive && motive.geofence && motive.geofence.id) || null;
    return jsonResponse({ success: motiveRes.ok, status: motiveRes.status, provider: "motive", geofence_id: motiveGid, geocodedVia, centre: { lat: centre_lat, lon: centre_lon }, motive });
  } catch (e) {
    const err = e as Error;
    console.error("[geofence-create] error:", err?.stack || err?.message || String(e));
    return jsonResponse({ success: false, error: "Geofence create failed." }, 500);
  }
});
