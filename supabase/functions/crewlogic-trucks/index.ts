// Supabase Edge Function: crewlogic-trucks (v1.0)
// Returns current truck GPS locations from Motive (gomotive.com). Migrated from
// the n8n Route Optimization workflow's `crewlogic-trucks` webhook (the small,
// app-facing piece — the large route-optimization engine stays in n8n for now).
//
// Used by the Route Optimizer (franchise-#90 tester) truck-distance display.
//
// Deploy: supabase functions deploy crewlogic-trucks
//
// SECRETS REQUIRED:
//   MOTIVE_API_KEY  — the Motive (gomotive.com) API key (x-api-key header).
//                     Copy it from the n8n "Get Truck Location" node's x-api-key
//                     header and set with: supabase secrets set MOTIVE_API_KEY=...
//
// Response: { success: true, trucks: [ { number, lat, lon, desc } ] }
// (Matches the n8n "Format Truck Locations" output the frontend reads as data.trucks.)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const MOTIVE_URL = "https://api.gomotive.com/v1/vehicle_locations";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

interface MotiveVehicleEntry {
  vehicle?: {
    number?: string | number;
    current_location?: { lat?: number; lon?: number; description?: string } | null;
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const apiKey = Deno.env.get("MOTIVE_API_KEY");
  if (!apiKey) return jsonResponse({ success: false, error: "MOTIVE_API_KEY not configured" }, 500);

  try {
    const res = await fetch(MOTIVE_URL, {
      headers: { accept: "application/json", "x-api-key": apiKey },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[crewlogic-trucks] Motive ${res.status}: ${body.slice(0, 200)}`);
      return jsonResponse({ success: false, error: `Motive request failed (${res.status})` }, 502);
    }
    const data = await res.json();
    const vehicles: MotiveVehicleEntry[] = data.vehicles || [];
    const trucks = vehicles
      .map((v) => {
        const loc = v.vehicle?.current_location || null;
        return {
          number: v.vehicle?.number ?? null,
          lat: loc?.lat ?? null,
          lon: loc?.lon ?? null,
          desc: loc?.description ?? "",
        };
      })
      .filter((t) => t.number != null);

    return jsonResponse({ success: true, trucks });
  } catch (e) {
    const err = e as Error;
    console.error("[crewlogic-trucks] error:", err?.message || err);
    return jsonResponse({ success: false, error: err.message || "Internal error" }, 500);
  }
});
