// Supabase Edge Function: crewlogic-route-disposal (v1.0)
// Route Optimizer R1 — disposal-stop recommender engine.
//
// Computes, for a loaded truck that must dispose BEFORE reaching a fixed endpoint:
//   truck current location → disposal site → endpoint (job or "Our location")
// the total time + total cost for each candidate disposal site, filters out sites
// that would be closed (hours/holiday) at the estimated arrival in the franchise's
// OWN local timezone, ranks the open ones, and returns the least-cost and
// least-time picks plus the full per-site breakdown.
//
// Spec: docs/plan-route-optimizer-r1.md (§3 inputs, §5 math, Resolved decisions)
//       docs/plan-route-optimizer-r1-schema.md (facilities / facility_hours / franchise_holidays)
//
// Deploy (DEV): supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb \
//                 crewlogic-route-disposal --use-api --no-verify-jwt
//
// SECRETS REQUIRED (auto-populated except the Google key):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   GOOGLE_GEOCODING_API_KEY  (must have the Distance Matrix API enabled)
//
// POST body:
//   { franchiseID, truckLat, truckLng, endpointAddress,
//     endpointScheduledTime? (ISO or null for "Our location"), loadPercent (0-100) }
//
// Response:
//   { success:true, timezoneUsed, leastCost:{...}, leastTime:{...}, sites:[ ... ] }
//   { success:false, error }   (safe message only; full detail is console.error'd)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveTimezone } from "../_shared/tz.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TENANT_ID = "946a4535-aa61-45b6-a6fb-9190ff546d41"; // Junkluggers

// Per-franchise cost-setting defaults (used when the field is blank/absent).
const DEFAULTS = {
  crewRate: 25,     // $/hr PER PERSON
  MPG: 10,
  fuelCost: 3.5,    // $/gal
  truckCY: 16,      // cubic yards at 100% full
  disposalWait: 15, // minutes idle at the disposal site
};
const TONS_PER_FULL_16CY = 16; // 16 CY = 1 ton (locked)

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Numeric parse with default: "" / null / NaN → def.
function num(v: unknown, def: number): number {
  if (v === null || v === undefined) return def;
  if (typeof v === "number") return Number.isFinite(v) ? v : def;
  const s = String(v).trim();
  if (s === "") return def;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : def;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round1(n: number): number { return Math.round(n * 10) / 10; }

// ─────────────────────────────────────────────────────────────────────────────
// Timezone — derive a franchise IANA tz from its US state when not stored.
// Multi-zone states resolved to their DOMINANT zone (the n8n hardcoded ET — the
// exact multi-tenant trap this function exists to avoid).
// ─────────────────────────────────────────────────────────────────────────────
// STATE_TZ + resolveTimezone now live in ../_shared/tz.ts (imported at the top of this file).
// This function used to declare its own copy, as did crewlogic-dispatch — one copy now.
// NOTE: the localParts() below is a DIFFERENT helper from _shared's todayPartsInTz(): this one
// takes an arbitrary instant and returns dow/minutesOfDay/label for facility-hours math.

// Local-time parts of a UTC instant in the given IANA tz.
interface LocalParts {
  year: number; month: number; day: number; // month 1-12
  dow: number;        // 0=Sun … 6=Sat
  minutesOfDay: number;
  label: string;      // "2026-06-18 14:30 EDT"
}
const DOW_MAP: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
};
function localParts(date: Date, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "long",
    timeZoneName: "short",
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const year = parseInt(get("year"), 10);
  const month = parseInt(get("month"), 10);
  const day = parseInt(get("day"), 10);
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // some runtimes emit "24" for midnight
  const minute = parseInt(get("minute"), 10);
  const dow = DOW_MAP[get("weekday")] ?? 0;
  const tzName = get("timeZoneName");
  const label = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ` +
    `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${tzName}`;
  return { year, month, day, dow, minutesOfDay: hour * 60 + minute, label };
}

// minutes-from-midnight → friendly 12-hour clock, e.g. 810 → "1:30pm". No tz suffix (the time is
// already in the franchise's local zone; we don't surface the zone label to the user).
function to12h(min: number): string {
  const mm = (((Math.round(min) % 1440) + 1440) % 1440);
  let h = Math.floor(mm / 60);
  const m = mm % 60;
  const ap = h < 12 ? "am" : "pm";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")}${ap}`;
}

// "HH:MM[:SS]" → minutes from midnight (null on blank).
function timeToMinutes(t: unknown): number | null {
  const s = String(t || "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// US federal holiday date resolution (calendar-date math; tz-independent).
// ─────────────────────────────────────────────────────────────────────────────
// nth (1-based) weekday of a month. weekday: 0=Sun … 6=Sat.
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (weekday - first + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}
function lastWeekday(year: number, month: number, weekday: number): number {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate(); // last day of month
  const lastDow = new Date(Date.UTC(year, month - 1, last)).getUTCDay();
  return last - ((lastDow - weekday + 7) % 7);
}
// Returns {month (1-12), day} for a federal holiday key in a given year, or null.
function federalHolidayDate(key: string, year: number): { month: number; day: number } | null {
  switch (key) {
    case "newYears":     return { month: 1, day: 1 };
    case "mlk":          return { month: 1, day: nthWeekday(year, 1, 1, 3) };   // 3rd Mon Jan
    case "presidents":   return { month: 2, day: nthWeekday(year, 2, 1, 3) };   // 3rd Mon Feb
    case "memorial":     return { month: 5, day: lastWeekday(year, 5, 1) };     // last Mon May
    case "juneteenth":   return { month: 6, day: 19 };
    case "independence": return { month: 7, day: 4 };
    case "labor":        return { month: 9, day: nthWeekday(year, 9, 1, 1) };   // 1st Mon Sep
    case "columbus":     return { month: 10, day: nthWeekday(year, 10, 1, 2) }; // 2nd Mon Oct
    case "veterans":     return { month: 11, day: 11 };
    case "thanksgiving": return { month: 11, day: nthWeekday(year, 11, 4, 4) }; // 4th Thu Nov
    case "christmas":    return { month: 12, day: 25 };
    default:             return null;
  }
}
const FEDERAL_LABEL: Record<string, string> = {
  newYears: "New Year's Day", mlk: "MLK Day", presidents: "Presidents' Day",
  memorial: "Memorial Day", juneteenth: "Juneteenth", independence: "Independence Day",
  labor: "Labor Day", columbus: "Columbus Day", veterans: "Veterans Day",
  thanksgiving: "Thanksgiving", christmas: "Christmas",
};

interface HolidayRow {
  federal_key: string | null;
  custom_label: string | null;
  custom_date: string | null; // 'YYYY-MM-DD'
  is_observed: boolean;
}
// Is the local arrival date a closed holiday? Returns the holiday label or null.
// Federal holidays are observed BY DEFAULT (matches the Settings UI default) — so a franchise that
// has never saved its holiday list (empty table, e.g. post-migration) still closes on them. A
// franchise opts a holiday OUT by saving it unchecked, which writes an is_observed=false row.
function holidayClosure(lp: LocalParts, holidays: HolidayRow[]): string | null {
  const unobserved = new Set<string>();
  for (const h of holidays) {
    if (h.federal_key && h.is_observed === false) unobserved.add(h.federal_key);
  }
  for (const key of Object.keys(FEDERAL_LABEL)) {
    if (unobserved.has(key)) continue;
    const fd = federalHolidayDate(key, lp.year);
    if (fd && fd.month === lp.month && fd.day === lp.day) return FEDERAL_LABEL[key];
  }
  // Custom (local) holidays — explicit rows only, observed unless turned off.
  for (const h of holidays) {
    if (h.federal_key || h.is_observed === false || !h.custom_date) continue;
    const m = h.custom_date.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m && parseInt(m[1], 10) === lp.year && parseInt(m[2], 10) === lp.month &&
        parseInt(m[3], 10) === lp.day) {
      return h.custom_label || "Holiday";
    }
  }
  return null;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function fmtClock(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

interface HoursRow { dow: number; is_closed: boolean; open_time: string | null; close_time: string | null; }
// Returns a closedReason string if the site is closed at the arrival local time, else null.
function hoursClosure(lp: LocalParts, hours: HoursRow[]): string | null {
  const row = hours.find((h) => h.dow === lp.dow);
  if (!row) return null; // no row → treat as open (no constraint configured)
  if (row.is_closed) return `closed ${DAY_NAMES[lp.dow]}s`;
  const open = timeToMinutes(row.open_time);
  const close = timeToMinutes(row.close_time);
  if (open !== null && lp.minutesOfDay < open) return `arrives before open (${fmtClock(open)})`;
  if (close !== null && lp.minutesOfDay >= close) return `arrives after close (${fmtClock(close)})`;
  return null;
}
// For an OPEN site: minutes between the truck's ARRIVAL and the facility's closing time (null if no
// closing time configured). Used to flag "cutting it close" when arrival is within ~15 min of close.
function minsUntilClose(lp: LocalParts, hours: HoursRow[]): number | null {
  const row = hours.find((h) => h.dow === lp.dow);
  if (!row || row.is_closed) return null;
  const close = timeToMinutes(row.close_time);
  if (close === null) return null;
  return close - lp.minutesOfDay;
}

// ─────────────────────────────────────────────────────────────────────────────
// Distance Matrix — one call, all sites. Token per point: "lat,lng" or address.
// ─────────────────────────────────────────────────────────────────────────────
interface Leg { miles: number; minutes: number; }
async function distanceMatrix(
  apiKey: string, origins: string[], destinations: string[],
): Promise<(Leg | null)[][]> {
  const url = "https://maps.googleapis.com/maps/api/distancematrix/json" +
    `?origins=${origins.map(encodeURIComponent).join("|")}` +
    `&destinations=${destinations.map(encodeURIComponent).join("|")}` +
    `&units=imperial&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Distance Matrix HTTP ${res.status}`);
  const data = await res.json() as {
    status: string; error_message?: string;
    rows?: Array<{ elements: Array<{ status: string; distance?: { value: number }; duration?: { value: number } }> }>;
  };
  if (data.status !== "OK") {
    throw new Error(`Google Distance Matrix: ${data.status}${data.error_message ? " — " + data.error_message : ""}`);
  }
  return (data.rows || []).map((row) =>
    (row.elements || []).map((cell) => {
      if (!cell || cell.status !== "OK" || !cell.distance || !cell.duration) return null;
      return {
        miles: Math.round((cell.distance.value / 1609.344) * 10) / 10,
        minutes: Math.round(cell.duration.value / 60),
      };
    }));
}

// Geocode a single address → {lat,lng} (null on failure). Used to fill coords for facilities that
// don't have them stored, so the chosen route can be plotted on the client map.
async function geocodeAddress(apiKey: string, address: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const url = "https://maps.googleapis.com/maps/api/geocode/json?address=" +
      encodeURIComponent(address) + "&key=" + apiKey;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as { results?: Array<{ geometry?: { location?: { lat: number; lng: number } } }> };
    const loc = data?.results?.[0]?.geometry?.location;
    return (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) ? { lat: loc.lat, lng: loc.lng } : null;
  } catch (_e) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch (_e) {
    return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
  }

  try {
    const franchiseID = String(body.franchiseID || "").trim();
    const truckLat = Number(body.truckLat);
    const truckLng = Number(body.truckLng);
    let endpointAddress = String(body.endpointAddress || "").trim();
    const endpointIsHome = body.endpointIsHome === true; // "Our location" → resolve from cost_settings server-side
    // Scheduled time as LOCAL minutes-since-midnight (franchise tz), e.g. 720 = 12:00 noon. The
    // workorder's `time` field is exactly this. NaN = no appointment (e.g. the "Our location" endpoint).
    const endpointScheduledMinutes = (body.endpointScheduledMinutes != null && body.endpointScheduledMinutes !== "")
      ? num(body.endpointScheduledMinutes, NaN) : NaN;
    const loadPercent = num(body.loadPercent, NaN);

    if (!franchiseID) return jsonResponse({ success: false, error: "franchiseID required" }, 400);
    if (!Number.isFinite(truckLat) || !Number.isFinite(truckLng)) {
      return jsonResponse({ success: false, error: "truckLat and truckLng required" }, 400);
    }
    if (!Number.isFinite(loadPercent)) return jsonResponse({ success: false, error: "loadPercent required" }, 400);
    // endpointAddress is validated AFTER cost_settings loads (the "Our location" endpoint resolves from it).

    const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || Deno.env.get("GOOGLE_MAPS_API_KEY");
    if (!apiKey) {
      console.error("[route-disposal] No Google Distance Matrix key configured.");
      return jsonResponse({ success: false, error: "Distance lookup is not configured." }, 500);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1) Resolve franchise (external_id → id, Junkluggers tenant) + cost_settings.
    const { data: franchiseRow, error: frErr } = await supabase
      .from("franchises")
      .select("id, cost_settings")
      .eq("external_id", franchiseID)
      .eq("tenant_id", TENANT_ID)
      .single();
    if (frErr || !franchiseRow) {
      return jsonResponse({ success: false, error: "Franchise not found: " + franchiseID }, 404);
    }
    const franchiseUUID = franchiseRow.id as string;
    const cs = (franchiseRow.cost_settings as Record<string, unknown>) || {};

    // "Our location" endpoint resolves server-side from cost_settings (truck home, else office
    // address) — single source of truth, independent of the client's possibly-stale session.
    if (endpointIsHome) {
      const office = [cs.officeAddress, cs.officeCity, cs.officeState, cs.officeZip]
        .map((v) => String(v || "").trim()).filter(Boolean).join(", ");
      endpointAddress = String(cs.truckHome || "").trim() || office;
    }
    if (!endpointAddress) {
      return jsonResponse({ success: false, error: endpointIsHome
        ? "Set your Truck Home (or office address) in Settings → Cost Analysis."
        : "endpointAddress required" }, 400);
    }

    const crewRate = num(cs.crewRate, DEFAULTS.crewRate);
    const MPG = num(cs.MPG, DEFAULTS.MPG);
    const fuelCost = num(cs.fuelCost, DEFAULTS.fuelCost);
    const truckCY = num(cs.truckCY, DEFAULTS.truckCY);
    const disposalWait = num(cs.disposalWait, DEFAULTS.disposalWait);
    const timezoneUsed = resolveTimezone(cs);

    // 2) Load percent → tons. tons = (load% × truckCY) / 16.
    const cy = (loadPercent / 100) * truckCY;
    const tons = round2(cy / TONS_PER_FULL_16CY);

    // 3) Load disposal facilities (service role), their hours, and franchise holidays.
    const { data: facilities, error: facErr } = await supabase
      .from("facilities")
      .select("id, name, address, latitude, longitude, per_ton_rate, minimum_type, minimum_value")
      .eq("franchise_id", franchiseUUID)
      .eq("type", "disposal")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });
    if (facErr) {
      console.error("[route-disposal] facilities query failed:", facErr.message);
      return jsonResponse({ success: false, error: "Could not load disposal sites." }, 500);
    }
    if (!facilities || !facilities.length) {
      return jsonResponse({ success: false, error: "No active disposal sites configured for this franchise." }, 404);
    }
    const facilityIds = facilities.map((f) => f.id);

    const { data: hoursRows } = await supabase
      .from("facility_hours")
      .select("facility_id, dow, is_closed, open_time, close_time")
      .in("facility_id", facilityIds);
    const hoursByFacility: Record<string, HoursRow[]> = {};
    for (const h of (hoursRows || [])) {
      (hoursByFacility[h.facility_id as string] ||= []).push(h as unknown as HoursRow);
    }

    const { data: holidayRows } = await supabase
      .from("franchise_holidays")
      .select("federal_key, custom_label, custom_date, is_observed")
      .eq("franchise_id", franchiseUUID);
    const holidays = (holidayRows || []) as unknown as HolidayRow[];

    // 3b) Fill coords for any facility lacking them (geocode the address, in parallel) — so the chosen
    // route can be plotted on the client map. Also tightens the distance tokens to lat/lng.
    await Promise.all((facilities as Record<string, unknown>[]).map(async (f) => {
      if ((f.latitude == null || f.longitude == null) && f.address) {
        const g = await geocodeAddress(apiKey, String(f.address));
        if (g) { f.latitude = g.lat; f.longitude = g.lng; }
      }
    }));

    // 4) Distance Matrix — origins = [truck, ...sites]; destinations = [...sites, endpoint].
    const siteToken = (f: Record<string, unknown>) =>
      (f.latitude != null && f.longitude != null) ? `${f.latitude},${f.longitude}` : String(f.address || "");
    const origins = [`${truckLat},${truckLng}`, ...facilities.map(siteToken)];
    const destinations = [...facilities.map(siteToken), endpointAddress];
    const matrix = await distanceMatrix(apiKey, origins, destinations);
    const endpointDestIdx = facilities.length; // endpoint is the last destination

    const now = new Date();
    const hasSchedule = Number.isFinite(endpointScheduledMinutes);

    // 5) Per-site cost + time + open/closed + late warning.
    const sites = facilities.map((f, i) => {
      const truckToSite = matrix[0]?.[i] ?? null;            // origin 0 → dest i
      const siteToEndpoint = matrix[1 + i]?.[endpointDestIdx] ?? null; // origin (1+i) → endpoint

      const base: Record<string, unknown> = {
        facilityId: f.id,
        name: f.name || "",
        address: f.address || "",
        latitude: f.latitude != null ? Number(f.latitude) : null,   // for plotting the dump on the map
        longitude: f.longitude != null ? Number(f.longitude) : null,
        tons,
      };

      if (!truckToSite || !siteToEndpoint) {
        return { ...base, open: false, closedReason: "distance lookup unavailable for this site" };
      }

      const totalRouteMinutes = truckToSite.minutes + siteToEndpoint.minutes;
      const totalTimeWithWait = totalRouteMinutes + disposalWait;
      const routeMiles = round1(truckToSite.miles + siteToEndpoint.miles);

      // Disposal fee — base prorated by tons; floored by minimum per minimum_type.
      const ratePos = Math.max(0, num(f.per_ton_rate, 0));
      const minType = String(f.minimum_type || "none");
      const minVal = num(f.minimum_value, 0);
      let disposalFee: number;
      if (minType === "weight") disposalFee = Math.max(tons, minVal) * ratePos;
      else if (minType === "dollar") disposalFee = Math.max(ratePos * tons, minVal);
      else disposalFee = ratePos * tons; // 'none'
      disposalFee = round2(disposalFee);

      // Labor (2-person crew, wait billed at full rate) + fuel.
      const laborCost = round2(2 * crewRate * (totalTimeWithWait / 60));
      const fuelCost$ = round2((routeMiles / MPG) * fuelCost);
      const totalCost = round2(disposalFee + laborCost + fuelCost$);

      // Arrival AT the disposal site — drives the hours/holiday open-check (is the dump open when
      // the truck pulls in?). This is now + the FIRST leg only.
      const arriveAtSite = new Date(now.getTime() + truckToSite.minutes * 60000);
      const siteLp = localParts(arriveAtSite, timezoneUsed);
      const holiday = holidayClosure(siteLp, holidays);
      const fhours = hoursByFacility[f.id as string] || [];
      const hourClose = hoursClosure(siteLp, fhours);
      const closedReason = holiday ? `closed for holiday (${holiday})` : hourClose;
      const open = !closedReason;
      // "Cutting it close": open, but the truck arrives within 15 min of the facility's closing time.
      const muc = open ? minsUntilClose(siteLp, fhours) : null;
      const cuttingItClose = muc !== null && muc > 0 && muc <= 15;

      // Arrival AT the job/endpoint — the displayed arrival + the late-warning base. This is the
      // WHOLE route: now + truck→site + wait + site→job (= totalTimeWithWait).
      const arriveAtEndpoint = new Date(now.getTime() + totalTimeWithWait * 60000);
      const endpointLp = localParts(arriveAtEndpoint, timezoneUsed);

      const out: Record<string, unknown> = {
        ...base,
        open,
        disposalFee,
        laborCost,
        fuelCost: fuelCost$,
        totalCost,
        driveMinutes: totalRouteMinutes,
        waitMinutes: disposalWait,
        totalTimeWithWait,
        routeMiles,
        arrivalLocal: endpointLp.label,        // full "YYYY-MM-DD HH:MM TZ" (kept for debugging)
        arrivalTime: to12h(endpointLp.minutesOfDay), // friendly "1:50pm" for display
        cuttingItClose,
      };
      if (cuttingItClose) out.minsUntilClose = muc;
      if (closedReason) out.closedReason = closedReason;

      // Late warning: compare the job-arrival's LOCAL wall-clock minutes to the appointment's local
      // minutes-since-midnight (both in the franchise tz — no UTC-offset math). Same-day assumed
      // (today's jobs; a drive crossing local midnight is an ignored v1 edge case).
      if (hasSchedule) {
        const minutesLate = endpointLp.minutesOfDay - endpointScheduledMinutes;
        out.minutesLate = minutesLate;
        out.warning = minutesLate < 0 ? "early"
          : minutesLate <= 30 ? "green"
          : minutesLate <= 90 ? "yellow"
          : "red";
      }
      return out;
    });

    // 6) Rank the OPEN sites → least-cost + least-time picks.
    const openSites = sites.filter((s) => s.open === true);
    const pickMin = (key: string) => openSites.reduce<Record<string, unknown> | null>(
      (best, s) => (best === null || (s[key] as number) < (best[key] as number)) ? s : best, null);
    const leastCost = pickMin("totalCost");
    const leastTime = pickMin("totalTimeWithWait");

    const jobStartTime = hasSchedule ? to12h(endpointScheduledMinutes) : null;
    return jsonResponse({ success: true, timezoneUsed, jobStartTime, endpointAddressUsed: endpointAddress, leastCost, leastTime, sites });
  } catch (e) {
    const err = e as Error;
    console.error("[route-disposal] error:", err?.stack || err?.message || String(e));
    return jsonResponse({ success: false, error: "Could not compute disposal routes." }, 500);
  }
});
