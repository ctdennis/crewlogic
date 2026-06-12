// Supabase Edge Function: crewlogic-trucks (v1.1)
// Returns current truck GPS locations from a telematics provider, normalized to a
// single shape the frontend reads as data.trucks.
//
//   provider = "motive" (default) | "linxup"   (via ?provider=… query param or POST body)
//
// - Motive (pull): GET api.gomotive.com/v1/vehicle_locations  (x-api-key: MOTIVE_API_KEY)
// - Linxup (pull): GET app02.linxup.com/ibis/rest/api/v2/locations
//                  (Authorization: Bearer <LINXUP_API_KEY>; the secret holds the RAW token,
//                   we prepend "Bearer " here)
//
// Default stays "motive" for backward-compat with the existing Route Optimizer (#90) consumer.
// Per-franchise provider resolution (from franchise config / Vault) is Phase 2.
//
// SECRETS:
//   MOTIVE_API_KEY  — Motive (gomotive.com) API key (x-api-key header)
//   LINXUP_API_KEY  — Linxup REST API token from POST /token/generate (raw, no "Bearer " prefix)
//
// Normalized response:
//   { success, provider, trucks: [ { number, name, lat, lon, speed, heading,
//                                    status, lastUpdate, make, model, year, vin, desc } ] }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const MOTIVE_URL = "https://api.gomotive.com/v1/vehicle_locations";
const LINXUP_URL = "https://app02.linxup.com/ibis/rest/api/v2/locations";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

interface Truck {
  number: string | number | null;
  name: string;
  lat: number | null;
  lon: number | null;
  speed: number | null;
  heading: string | null;
  status: string | null;
  lastUpdate: number | null; // ms since epoch
  make: string | null;
  model: string | null;
  year: string | null;
  vin: string | null;
  desc: string;
}

// ---- Motive ----
interface MotiveVehicleEntry {
  vehicle?: {
    number?: string | number;
    current_location?: { lat?: number; lon?: number; description?: string } | null;
  };
}
function fromMotive(data: { vehicles?: MotiveVehicleEntry[] }): Truck[] {
  return (data.vehicles || [])
    .map((v): Truck => {
      const loc = v.vehicle?.current_location || null;
      return {
        number: v.vehicle?.number ?? null,
        name: String(v.vehicle?.number ?? ""),
        lat: loc?.lat ?? null,
        lon: loc?.lon ?? null,
        speed: null,
        heading: null,
        status: null,
        lastUpdate: null,
        make: null,
        model: null,
        year: null,
        vin: null,
        desc: loc?.description ?? "",
      };
    })
    .filter((t) => t.number != null);
}

// ---- Linxup ----
interface LinxupLocation {
  imei?: string;
  personName?: string;
  firstName?: string;
  latitude?: number;
  longitude?: number;
  speed?: number;
  heading?: string;
  status?: string;
  date?: number;
  make?: string;
  model?: string;
  year?: string;
  vin?: string;
}
function fromLinxup(data: { data?: { locations?: LinxupLocation[] } }): Truck[] {
  return (data?.data?.locations || [])
    .map((l): Truck => ({
      number: l.personName || l.firstName || l.imei || null,
      name: l.personName || l.firstName || l.imei || "",
      lat: l.latitude ?? null,
      lon: l.longitude ?? null,
      speed: l.speed ?? null,
      heading: l.heading ?? null,
      status: l.status ?? null,
      lastUpdate: l.date ?? null,
      make: l.make ?? null,
      model: l.model ?? null,
      year: l.year ?? null,
      vin: l.vin ?? null,
      desc: l.status ?? "",
    }))
    .filter((t) => t.lat != null && t.lon != null);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // provider: ?provider=… or POST body { provider }
  let provider = new URL(req.url).searchParams.get("provider") || "";
  if (!provider && req.method === "POST") {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    provider = String((body as { provider?: string }).provider || "");
  }
  provider = (provider || "motive").toLowerCase();

  try {
    if (provider === "linxup") {
      const token = Deno.env.get("LINXUP_API_KEY");
      if (!token) return jsonResponse({ success: false, error: "LINXUP_API_KEY not configured" }, 500);
      const res = await fetch(LINXUP_URL, {
        headers: { accept: "application/json", Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[crewlogic-trucks] Linxup ${res.status}: ${body.slice(0, 200)}`);
        return jsonResponse({ success: false, error: `Linxup request failed (${res.status})` }, 502);
      }
      const data = await res.json();
      return jsonResponse({ success: true, provider: "linxup", trucks: fromLinxup(data) });
    }

    // default: motive
    const apiKey = Deno.env.get("MOTIVE_API_KEY");
    if (!apiKey) return jsonResponse({ success: false, error: "MOTIVE_API_KEY not configured" }, 500);
    const res = await fetch(MOTIVE_URL, {
      headers: { accept: "application/json", "x-api-key": apiKey },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[crewlogic-trucks] Motive ${res.status}: ${body.slice(0, 200)}`);
      return jsonResponse({ success: false, error: `Motive request failed (${res.status})` }, 502);
    }
    const data = await res.json();
    return jsonResponse({ success: true, provider: "motive", trucks: fromMotive(data) });
  } catch (e) {
    const err = e as Error;
    console.error("[crewlogic-trucks] error:", err?.message || err);
    return jsonResponse({ success: false, error: err.message || "Internal error" }, 500);
  }
});
