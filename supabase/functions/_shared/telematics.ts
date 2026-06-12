// _shared/telematics.ts
// One place that knows how to pull live truck locations from a telematics
// provider and normalize them to a single shape. Used by BOTH:
//   - crewlogic-trucks    (serve the "Where Are My Trucks?" screen)
//   - crewlogic-settings  (validate a token on save: "Connected ✓ — N trucks")
//
// Providers (per-franchise, either/or):
//   motive  → GET api.gomotive.com/v1/vehicle_locations   (x-api-key: <token>)
//   linxup  → GET app02.linxup.com/ibis/rest/api/v2/locations
//             (Authorization: Bearer <token>; token is the RAW Linxup REST token)

export const MOTIVE_URL = "https://api.gomotive.com/v1/vehicle_locations";
export const LINXUP_URL = "https://app02.linxup.com/ibis/rest/api/v2/locations";

export interface Truck {
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

export interface FetchTrucksResult {
  success: boolean;
  provider: string;
  trucks: Truck[];
  error?: string;
  status?: number; // upstream HTTP status on failure
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

// Pull + normalize. Never throws for upstream/HTTP problems — returns a result
// with success:false so callers can surface a clean "couldn't connect" message.
export async function fetchTrucks(provider: string, token: string): Promise<FetchTrucksResult> {
  const p = (provider || "").toLowerCase();
  if (!token) return { success: false, provider: p, trucks: [], error: "Missing API token" };

  try {
    if (p === "linxup") {
      const res = await fetch(LINXUP_URL, {
        headers: { accept: "application/json", Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[telematics] Linxup ${res.status}: ${body.slice(0, 200)}`);
        return { success: false, provider: p, trucks: [], error: `Linxup request failed (${res.status})`, status: res.status };
      }
      return { success: true, provider: p, trucks: fromLinxup(await res.json()) };
    }

    if (p === "motive") {
      const res = await fetch(MOTIVE_URL, {
        headers: { accept: "application/json", "x-api-key": token },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[telematics] Motive ${res.status}: ${body.slice(0, 200)}`);
        return { success: false, provider: p, trucks: [], error: `Motive request failed (${res.status})`, status: res.status };
      }
      return { success: true, provider: p, trucks: fromMotive(await res.json()) };
    }

    return { success: false, provider: p, trucks: [], error: `Unknown provider: ${provider}` };
  } catch (e) {
    const err = e as Error;
    console.error("[telematics] fetch error:", err?.message || err);
    return { success: false, provider: p, trucks: [], error: err.message || "Internal error" };
  }
}
