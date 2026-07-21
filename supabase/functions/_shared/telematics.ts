// _shared/telematics.ts
// One place that knows how to pull live truck locations from a telematics
// provider and normalize them to a single shape. Used by BOTH:
//   - crewlogic-trucks    (serve the "Where Are My Trucks?" screen)
//   - crewlogic-settings  (validate a token on save: "Connected ✓ — N trucks")
//
// Providers (per-franchise, either/or):
//   motive  → GET api.gomotive.com/v2/vehicle_locations   (x-api-key: <token>)
//   linxup  → GET app02.linxup.com/ibis/rest/api/v2/locations
//             (Authorization: Bearer <token>; token is the RAW Linxup REST token)

// MEASURED 2026-07-21 — v1, v2 and v3 all return 200 with the same credential:
//   v1 and v2 are the SAME feed (identical timestamps and shape in every sample).
//   v3 is a DIFFERENT, far fresher feed, and returns richer data.
// Two samples 43s apart while Truck 3 was moving:
//   v1/v2  located_at 14:52:05Z — FROZEN across both calls (~28 min stale)
//   v3     located_at 15:19:16Z → 15:20:01Z — tracking live, ~2s behind
// v3 also gives a street address ("27 Schofield St, Providence, RI") instead of "7.4 mi S of
// Lakeville", and an explicit vehicle_state (moving/off) instead of inferring from breadcrumbs.
//
// CAVEAT before switching: for a LONG-PARKED truck v3 reported an OLDER located_at than v1/v2
// (v3 said yesterday 14:58Z, v1/v2 said today 03:48Z) — v3 looks like the last genuine GPS fix
// while v1/v2 emit a later heartbeat for a stationary vehicle. More honest, but a parked truck
// would display a much older "time ago" than it does today. Confirm that before flipping.
//
// SWITCHED 2026-07-21 (owner approved): v3 is now the POSITION source. v2 is still fetched, for
// two reasons — it carries the telemetry v3 omits (odometer / engine hours / fuel / battery /
// driver, all shown on the truck detail card), and it is the fallback when v3 fails or returns
// nothing. Both fire in parallel.
export const MOTIVE_URL_V3 = "https://api.gomotive.com/v3/vehicle_locations?per_page=100&page_no=1";
export const MOTIVE_URL = "https://api.gomotive.com/v2/vehicle_locations?per_page=100&page_no=1";
export const LINXUP_URL = "https://app02.linxup.com/ibis/rest/api/v2/locations";

export interface Truck {
  number: string | number | null;
  name: string;
  lat: number | null;
  lon: number | null;
  speed: number | null;
  heading: string | null;       // cardinal (N/NE/…) for display
  bearingDeg: number | null;    // course over ground in degrees (for the map arrow); null when unknown/parked
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
// Inverse: a numeric-or-cardinal heading → degrees (for providers that only give a compass string).
function headingToDegrees(h: string | number | null | undefined): number | null {
  if (h == null) return null;
  const n = typeof h === "number" ? h : parseFloat(String(h));
  if (!isNaN(n)) return ((n % 360) + 360) % 360;
  const map: Record<string, number> = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
  const key = String(h).trim().toUpperCase();
  return key in map ? map[key] : null;
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
// ---- Motive v3 ----
// Different feed, different shape. Position fields only — v3 carries NO odometer, engine hours,
// fuel, battery or driver, which the truck detail card displays. Those are merged in from v2.
interface MotiveV3Location {
  lat?: number;
  lon?: number;
  bearing?: number;
  located_at?: string;
  kph?: number;                 // v3 reports KPH; v2 reported MPH
  vehicle_state?: string;       // "moving" | "off" | ...  (v2 used type: "breadcrumb"/"engine_stop")
  current_location?: string;    // street address, e.g. "27 Schofield St, Providence, RI 02906"
  city?: string;
  state?: string;
}
interface MotiveV3Entry {
  vehicle?: {
    number?: string | number;
    make?: string;
    model?: string;
    year?: string | number;
    vin?: string;
    current_location?: MotiveV3Location | null;
  };
}

// Map v3's vehicle_state into the vocabulary the FRONTEND already understands
// (_truckStatusLabel maps engine_stop / engine_idle / ignition_on / breadcrumb). Translating here
// means index.html needs no change and existing truck colours and labels keep working — a raw
// "off" would have fallen through to a bare "Off" label and lost "Parked (engine off)".
function v3StateToStatus(s?: string): string | null {
  const v = String(s || "").toLowerCase();
  if (!v) return null;
  // Match on the STEM, not the dictionary word: v3 sends gerunds. "moving" does not contain
  // "move", and "idling" does not contain "idle" — both branches were dead until this was caught
  // by reading the live output rather than trusting the code.
  if (v.includes("mov") || v.includes("driv")) return "breadcrumb";
  if (v.includes("idl")) return "engine_idle";
  if (v === "on" || v.includes("ignition_on")) return "ignition_on";
  if (v === "off" || v.includes("stop") || v.includes("park")) return "engine_stop";
  return v;
}

const KPH_TO_MPH = 0.621371;

function fromMotiveV3(data: { vehicles?: MotiveV3Entry[] }): Truck[] {
  return (data.vehicles || [])
    .map((v): Truck => {
      const veh = v.vehicle || {};
      const loc = veh.current_location || null;
      const located = loc?.located_at ? Date.parse(loc.located_at) : NaN;
      // v3's street address beats v2's "7.4 mi S of Lakeville" — it is also what the popup turns
      // into a maps link. Fall back to city/state when the address is absent.
      const desc = loc?.current_location
        || [loc?.city, loc?.state].filter(Boolean).join(", ")
        || "";
      return {
        number: veh.number ?? null,
        name: String(veh.number ?? ""),
        lat: loc?.lat ?? null,
        lon: loc?.lon ?? null,
        speed: loc?.kph != null ? Math.round(loc.kph * KPH_TO_MPH) : null,
        heading: bearingToCompass(loc?.bearing),
        bearingDeg: loc?.bearing ?? null,
        status: v3StateToStatus(loc?.vehicle_state),
        lastUpdate: isNaN(located) ? null : located,
        make: veh.make ?? null,
        model: veh.model ?? null,
        year: veh.year != null ? String(veh.year) : null,
        vin: veh.vin ?? null,
        desc,
        // Not reported by v3 — filled from v2 by mergeMotiveTelemetry().
        odometer: null,
        engineHours: null,
        fuelType: null,
        fuelPercent: null,
        batteryVoltage: null,
        driver: null,
      };
    })
    .filter((t) => t.number != null);
}

// v3 gives the freshest POSITION; v2 gives the vehicle TELEMETRY the truck detail card shows
// (driver, odometer, engine hours, fuel, battery). Switching to v3 alone would silently blank that
// whole panel, so the two are merged: v3 wins on everything positional, v2 fills the rest.
// Matched on VIN first (survives a rename in the Motive portal), falling back to the number.
function mergeMotiveTelemetry(primary: Truck[], secondary: Truck[]): Truck[] {
  const byVin = new Map<string, Truck>();
  const byNum = new Map<string, Truck>();
  for (const s of secondary) {
    if (s.vin) byVin.set(String(s.vin).toUpperCase(), s);
    if (s.number != null) byNum.set(String(s.number).toLowerCase(), s);
  }
  return primary.map((p) => {
    const m = (p.vin && byVin.get(String(p.vin).toUpperCase()))
      || (p.number != null && byNum.get(String(p.number).toLowerCase()))
      || null;
    if (!m) return p;
    return {
      ...p,
      odometer: p.odometer ?? m.odometer,
      engineHours: p.engineHours ?? m.engineHours,
      fuelType: p.fuelType ?? m.fuelType,
      fuelPercent: p.fuelPercent ?? m.fuelPercent,
      batteryVoltage: p.batteryVoltage ?? m.batteryVoltage,
      driver: p.driver ?? m.driver,
    };
  });
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
        bearingDeg: loc?.bearing ?? null,
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
      bearingDeg: headingToDegrees(l.heading),
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
      // v3 for POSITION (near-live), v2 for TELEMETRY (odometer/hours/fuel/battery/driver, which
      // v3 does not return). Fired in parallel — one round trip's worth of latency, not two.
      const hdrs = { accept: "application/json", "x-api-key": token };
      const [v3Res, v2Res] = await Promise.all([
        fetch(MOTIVE_URL_V3, { headers: hdrs }).catch(() => null),
        fetch(MOTIVE_URL, { headers: hdrs }).catch(() => null),
      ]);

      // v2 is also the FALLBACK. If v3 fails or returns nothing usable, serve v2 alone rather than
      // showing an empty map — a stale position beats no position.
      const v2Trucks = (v2Res && v2Res.ok) ? fromMotive(await v2Res.json().catch(() => ({}))) : [];

      if (v3Res && v3Res.ok) {
        const v3Trucks = fromMotiveV3(await v3Res.json().catch(() => ({})));
        if (v3Trucks.length) {
          return { success: true, provider: p, trucks: mergeMotiveTelemetry(v3Trucks, v2Trucks) };
        }
        console.error("[telematics] Motive v3 returned no vehicles — falling back to v2");
      } else if (v3Res) {
        const body = await v3Res.text().catch(() => "");
        console.error(`[telematics] Motive v3 ${v3Res.status}: ${body.slice(0, 200)} — falling back to v2`);
      }

      if (v2Res && v2Res.ok) return { success: true, provider: p, trucks: v2Trucks };

      const status = (v2Res && v2Res.status) || (v3Res && v3Res.status) || 0;
      const body = v2Res ? await v2Res.text().catch(() => "") : "";
      console.error(`[telematics] Motive ${status}: ${body.slice(0, 200)}`);
      return { success: false, provider: p, trucks: [], error: `Motive request failed (${status})`, status };
    }

    return { success: false, provider: p, trucks: [], error: `Unknown provider: ${provider}` };
  } catch (e) {
    const err = e as Error;
    console.error("[telematics] fetch error:", err?.message || err);
    return { success: false, provider: p, trucks: [], error: err.message || "Internal error" };
  }
}
