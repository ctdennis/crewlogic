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

export const MOTIVE_URL = "https://api.gomotive.com/v2/vehicle_locations?per_page=100&page_no=1";
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
  odometer: number | null;       // miles
  engineHours: number | null;
  fuelType: string | null;
  fuelPercent: number | null;    // % remaining, when reported
  batteryVoltage: number | null; // volts, when reported
  driver: string | null;         // current driver, when logged in
}

export interface FetchTrucksResult {
  success: boolean;
  provider: string;
  trucks: Truck[];
  error?: string;
  status?: number; // upstream HTTP status on failure
}

// ---- Motive ----
function bearingToCompass(deg: number | null | undefined): string | null {
  if (deg == null || isNaN(deg)) return null;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
interface MotiveCurrentLocation {
  lat?: number;
  lon?: number;
  located_at?: string; // ISO timestamp
  bearing?: number; // degrees
  speed?: number; // mph
  type?: string; // e.g. "moving" | "stationary"
  description?: string; // reverse-geocoded address
  odometer?: number;
  true_odometer?: number;
  engine_hours?: number;
  battery_voltage?: number;
  fuel_primary_remaining_percentage?: number;
}
interface MotiveDriver {
  first_name?: string;
  last_name?: string;
}
interface MotiveVehicleEntry {
  vehicle?: {
    number?: string | number;
    make?: string;
    model?: string;
    year?: string | number;
    vin?: string;
    fuel_type?: string;
    current_location?: MotiveCurrentLocation | null;
  };
  current_driver?: MotiveDriver | null;
}
function fromMotive(data: { vehicles?: MotiveVehicleEntry[] }): Truck[] {
  return (data.vehicles || [])
    .map((v): Truck => {
      const veh = v.vehicle || {};
      const loc = veh.current_location || null;
      const drv = v.current_driver || null;
      const located = loc?.located_at ? Date.parse(loc.located_at) : NaN;
      const odo = loc?.odometer ?? loc?.true_odometer;
      const driverName = drv ? [drv.first_name, drv.last_name].filter(Boolean).join(" ").trim() : "";
      return {
        number: veh.number ?? null,
        name: String(veh.number ?? ""),
        lat: loc?.lat ?? null,
        lon: loc?.lon ?? null,
        speed: loc?.speed != null ? Math.round(loc.speed) : null,
        heading: bearingToCompass(loc?.bearing),
        status: loc?.type ? String(loc.type) : null,
        lastUpdate: isNaN(located) ? null : located,
        make: veh.make ?? null,
        model: veh.model ?? null,
        year: veh.year != null ? String(veh.year) : null,
        vin: veh.vin ?? null,
        desc: loc?.description ?? "",
        odometer: odo != null ? Math.round(odo) : null,
        engineHours: loc?.engine_hours != null ? Math.round(loc.engine_hours) : null,
        fuelType: veh.fuel_type ?? null,
        fuelPercent: loc?.fuel_primary_remaining_percentage ?? null,
        batteryVoltage: loc?.battery_voltage ?? null,
        driver: driverName || null,
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
      odometer: null,
      engineHours: null,
      fuelType: null,
      fuelPercent: null,
      batteryVoltage: null,
      driver: null,
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
