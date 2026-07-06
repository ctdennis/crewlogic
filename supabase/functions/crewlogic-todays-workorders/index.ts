// Supabase Edge Function: crewlogic-todays-workorders (v1.4)
// Fetches WorkOrders for a given franchise + Eastern day window from Vonigo
// and returns a simplified, filtered list for the "Today's Schedule" picker.
//
// v1.4: Added optional `includePlanData: true` flag. When set, the response
//   includes confidential fields used by the Job Plan AI: `notes` (fieldID
//   200 — customer situation, safety, VIP context — NEVER shown to crew or
//   customers) and `itemLocations` (fieldID 11215 — array of checked
//   locations like ["1st Floor", "Basement"]). The picker DOES NOT request
//   this data; only the Job Plan flow should set the flag.
//
// Deploy: supabase functions deploy crewlogic-todays-workorders
//
// Request body:
//   { franchiseID: string,   // e.g. "90"
//     dayOffset?: number }   // -1 (yesterday) | 0 (today) | 1 (tomorrow). Default 0.
//
// Response:
//   { success: true,
//     workOrders: [
//       { jobID, workOrderID, clientName, address, time, timeLabel,
//         status, route, dateService, price, isComplete }
//     ] }
//
// Notes:
//   - Dates use Vonigo's naive-Eastern epoch convention (the clock-face time
//     for America/New_York treated as if it were UTC). dateMode=3 filter
//     bounds use the same encoding.
//   - franchiseID is server-side filtered by Vonigo (sub-second response).
//   - Cancelled jobs (status optionID 162) and UCB route jobs (route name
//     contains "URGENTCB") are filtered out before returning.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// CORS headers — allow calls from the PWA.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TENANT_ID = '946a4535-aa61-45b6-a6fb-9190ff546d41'; // Junkluggers
const VONIGO_BASE = 'https://junkluggers.vonigo.com/api/v1';

// Vonigo status optionIDs (from system/objects metadata, objectTypeID 19 WorkOrder)
const STATUS_CANCELLED = 162;
const STATUS_OPEN = 160;
const STATUS_OPEN_BOOKED = 161;
const STATUS_IN_PROGRESS = 163;
const STATUS_COMPLETED = 164;
const STATUS_ARCHIVED = 165;

// fieldIDs we care about (objectTypeID 19 WorkOrder)
const F_STATUS = 181;
const F_CLIENT_NAME = 183;
const F_ADDRESS = 184;
const F_DATE_SERVICE = 185;
const F_TIME_MINUTES = 9082; // minutes from midnight of the appointment
const F_PRICE = 813;
const F_ITEMS = 10336; // customer-facing items list (safe to display)
const F_LABEL = 201;   // appointment label/category (drives the Vonigo schedule pill color)
// Field-201 LABEL optionIDs that mean a job is "done" → render gray (mapped from Vonigo 2026-06-22):
// 245=Estimate Completed (Job), 9996=Estimate Completed (Est. Only), 9993=Lost. Converted labels
// (9975 Job / 9970 Est.Only) and National Account (9981) stay ACTIVE until status Archived.
const GRAY_LABELS = new Set([245, 9996, 9993]);
// Fields exposed only when `includePlanData: true` — these are internal/
// confidential and should NEVER be returned for the customer-facing picker.
const F_NOTES = 200; // customer situation, safety, VIP, lugger-only context
const F_ITEM_LOCATIONS = 11215; // multi-checkbox: Basement, 1st Floor, etc.

interface VonigoField {
  fieldID: number;
  fieldValue: string | null;
  optionID: number;
}
interface VonigoRelation {
  objectTypeID: number;
  objectID: number;
  name: string;
  relationType: string;
  isActive: boolean;
}
interface VonigoWorkOrder {
  objectID: string;
  Fields: VonigoField[];
  Relations: VonigoRelation[];
}

// Returns naive-Eastern epoch for midnight of (today + dayOffset days) in
// America/New_York. The integer represents Eastern clock-face midnight
// treated as if it were UTC — Vonigo's convention.
function getEasternMidnightEpoch(dayOffset: number): number {
  // Get current Eastern date components
  const now = new Date();
  const easternStr = now.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  // easternStr looks like "05/13/2026, 10:30:00"
  const match = easternStr.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) throw new Error('Failed to parse Eastern date: ' + easternStr);
  const month = parseInt(match[1], 10) - 1; // 0-indexed
  const day = parseInt(match[2], 10) + dayOffset;
  const year = parseInt(match[3], 10);
  // Encode "Eastern midnight" as if it were UTC (naive-Eastern convention)
  return Math.floor(Date.UTC(year, month, day, 0, 0, 0) / 1000);
}

// Format minutes-from-midnight into "h:mm AM/PM"
function formatTimeLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return '';
  const h24 = Math.floor(minutes / 60) % 24;
  const m = Math.floor(minutes % 60);
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 === 0 ? 12 : (h24 > 12 ? h24 - 12 : h24);
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

// Extract a field's value (or optionID) from a Vonigo Fields array
function getField(fields: VonigoField[], id: number): VonigoField | undefined {
  return fields.find((f) => f.fieldID === id);
}

// Forward-geocode a US street address via the free US Census Geocoder (no API
// key, US addresses). Returns null when there's no confident match.
async function geocodeCensus(address: string): Promise<{ lat: number; lon: number } | null> {
  const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'
    + '?address=' + encodeURIComponent(address)
    + '&benchmark=Public_AR_Current&format=json';
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const m = data?.result?.addressMatches?.[0];
  if (!m?.coordinates) return null;
  const lat = Number(m.coordinates.y);
  const lon = Number(m.coordinates.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

// Google Geocoding — rooftop-accurate; the PRIMARY geocoder for job pins (and thus the job-site
// geofences + the <60m "arrived" house-on-truck icon, which all derive from the same coordinate).
// Returns {found:true,lat,lon} on a hit, {found:false} on a definitive ZERO_RESULTS (cache it, don't
// retry), or null on a transient error (OVER_QUERY_LIMIT / REQUEST_DENIED / network) so the caller
// falls back to Census and retries Google next time.
async function geocodeGoogle(apiKey: string, address: string): Promise<{ found: boolean; lat?: number; lon?: number } | null> {
  try {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?address='
      + encodeURIComponent(address) + '&key=' + apiKey;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const status = data?.status;
    if (status === 'OK') {
      const loc = data.results?.[0]?.geometry?.location;
      const lat = Number(loc?.lat), lon = Number(loc?.lng);
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { found: true, lat, lon };
      return null;
    }
    if (status === 'ZERO_RESULTS') return { found: false }; // definitive not-found → cache, don't retry
    return null;                                            // transient → fall back to Census, retry later
  } catch (_e) { return null; }
}

// Parse Vonigo's multi-checkbox field format into an array of CHECKED labels.
// Format: "optionID!~!Label!`!1!!~~!!optionID!~!Label!`!0!!~~!!..."
// The bit between `!\`!` and `!!` is 1 if checked, 0 if unchecked.
// Example input:
//   "18910!~!Basement!`!0!!~~!!18911!~!1st Floor!`!1!!~~!!18912!~!2nd Floor!`!1!!"
// Returns: ["1st Floor", "2nd Floor"]
function parseItemLocations(raw: string): string[] {
  if (!raw) return [];
  const checked: string[] = [];
  // Split on the row separator
  const rows = raw.split(/!~~!!?/);
  for (const row of rows) {
    if (!row.trim()) continue;
    // Each row: "optionID!~!Label!`!checked"
    const m = row.match(/^\d+!~!([^!]+(?:!(?!~!)[^!]*)*)!`!([01])/);
    if (m && m[2] === '1') {
      checked.push(m[1].trim());
    }
  }
  return checked;
}

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const franchiseID = String(body.franchiseID || '');
    const dayOffset = Number.isFinite(body.dayOffset) ? Number(body.dayOffset) : 0;
    // When true, response also includes notes (fieldID 200) and itemLocations
    // (fieldID 11215). These are confidential/internal and only used by the
    // Job Plan flow, not the customer-facing job picker.
    const includePlanData = body.includePlanData === true;
    // When true, geocode OPEN jobs (cache-first) and attach lat/lon for the truck map.
    const includeCoords = body.includeCoords === true;
    // When true, INCLUDE cancelled jobs (flagged `isCancelled`) instead of dropping them. Used by
    // crewlogic-job-geofence-sync so a same-day cancel deactivates its geofence right away (an
    // EXPLICIT cancel is a safe delete signal, unlike "missing from list"). Default off keeps the
    // customer-facing picker clean.
    const includeCancelled = body.includeCancelled === true;

    if (!franchiseID) {
      return new Response(JSON.stringify({ success: false, error: 'franchiseID required' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // 1) Fetch Vonigo credentials for this franchise
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: franchiseRow, error: franchiseErr } = await supabase
      .from('franchises')
      .select('id')
      .eq('external_id', franchiseID)
      .eq('tenant_id', TENANT_ID)
      .single();

    if (franchiseErr || !franchiseRow) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Franchise not found: ' + franchiseID,
      }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const { data: credRows, error: credErr } = await supabase
      .rpc('get_vonigo_credential', { franchise_id_param: franchiseRow.id });

    // Some deployments use a different param name. Try a few common variants
    // before giving up.
    let creds: { vonigo_username: string; vonigo_md5: string } | null = null;
    let credDebug = '';

    if (!credErr && credRows && credRows.length > 0) {
      creds = credRows[0];
      credDebug = 'param=franchise_id_param';
    } else {
      // Try alternate parameter names
      const tryParams = ['p_franchise_id', 'franchise_id', 'franchiseid', 'fid'];
      for (const paramName of tryParams) {
        const args: Record<string, string> = {};
        args[paramName] = franchiseRow.id;
        const r = await supabase.rpc('get_vonigo_credential', args);
        if (!r.error && r.data && r.data.length > 0) {
          creds = r.data[0];
          credDebug = 'param=' + paramName;
          break;
        }
      }
    }

    if (!creds) {
      // Last resort: fall back to a direct table query if the table exists
      const { data: directRows, error: directErr } = await supabase
        .from('vonigo_credentials')
        .select('vonigo_username, vonigo_md5')
        .eq('franchise_id', franchiseRow.id)
        .limit(1);
      if (!directErr && directRows && directRows.length > 0) {
        creds = directRows[0];
        credDebug = 'direct-table';
      }
    }

    if (!creds) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Vonigo credentials not found for franchise ' + franchiseID,
        debug: {
          franchiseInternalID: franchiseRow.id,
          tenantID: TENANT_ID,
          rpcError: credErr?.message || null,
          attempts: 'tried RPC with multiple param names and direct table query',
        },
      }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const { vonigo_username, vonigo_md5 } = creds;

    // 2) Authenticate with Vonigo
    const authUrl = new URL(VONIGO_BASE + '/security/login/');
    authUrl.searchParams.set('company', 'Vonigo');
    authUrl.searchParams.set('userName', vonigo_username);
    authUrl.searchParams.set('password', vonigo_md5);

    const authRes = await fetch(authUrl.toString());
    const authData = await authRes.json();
    if (authData.errNo !== 0 || !authData.securityToken) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Vonigo auth failed: ' + (authData.errMsg || 'no token'),
      }), { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const securityToken = authData.securityToken;

    // 3) Compute date bracket (naive-Eastern epoch)
    const dateStart = getEasternMidnightEpoch(dayOffset);
    const dateEnd = dateStart + 86400; // +1 day

    // 4) Query WorkOrders with server-side franchise filter
    const woRes = await fetch(VONIGO_BASE + '/data/WorkOrders/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        securityToken,
        franchiseID,
        pageNo: '1',
        pageSize: '200',
        sortMode: '1',
        sortDirection: '1',
        isCompleteObject: 'true',
        dateMode: '3',
        dateStart: String(dateStart),
        dateEnd: String(dateEnd),
      }),
    });

    const woData = await woRes.json();
    if (woData.errNo !== 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Vonigo WorkOrders query failed: ' + (woData.errMsg || 'errNo ' + woData.errNo),
      }), { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const workOrdersRaw: VonigoWorkOrder[] = woData.WorkOrders || [];

    // 5) Transform + filter
    const workOrders = workOrdersRaw
      .map((wo) => {
        const fields = wo.Fields || [];
        const relations = wo.Relations || [];

        const statusField = getField(fields, F_STATUS);
        const statusOptionID = statusField?.optionID || 0;
        const statusLabel = statusField?.fieldValue || '';

        const jobRel = relations.find((r) => r.relationType === 'job');
        const routeRel = relations.find((r) => r.relationType === 'route');

        const timeMin = parseInt(getField(fields, F_TIME_MINUTES)?.fieldValue || '0', 10);
        const dateService = parseInt(getField(fields, F_DATE_SERVICE)?.fieldValue || '0', 10);
        const price = parseFloat(getField(fields, F_PRICE)?.fieldValue || '0');

        const base = {
          jobID: jobRel?.objectID ? String(jobRel.objectID) : null,
          workOrderID: wo.objectID,
          clientName: getField(fields, F_CLIENT_NAME)?.fieldValue || '',
          address: getField(fields, F_ADDRESS)?.fieldValue || '',
          items: getField(fields, F_ITEMS)?.fieldValue || '',
          time: timeMin,
          timeLabel: formatTimeLabel(timeMin),
          status: statusLabel,
          statusOptionID,
          route: routeRel?.name || '',
          dateService,
          price,
          isComplete: statusOptionID === STATUS_COMPLETED || statusOptionID === STATUS_ARCHIVED,
          // isCancelled: cancel variants — plain "Cancelled" (162) + same-day "Cancelled - Today" (163);
          // matched by id OR status text so all variants flag. Only surfaced when includeCancelled.
          isCancelled: statusOptionID === STATUS_CANCELLED || /cancel/i.test(String(statusLabel || '')),
          // labelDone: field-201 label marks it "done" (Estimate Completed Job/Est.Only, or Lost) even with
          // status Open → render gray. (Converted/National-Account labels gray only on Archived = isComplete.)
          labelDone: GRAY_LABELS.has(getField(fields, F_LABEL)?.optionID || 0),
          lat: null as number | null,
          lon: null as number | null,
        };

        if (!includePlanData) return base;

        // Add plan-only fields (confidential — for Job Plan flow only)
        return {
          ...base,
          notes: getField(fields, F_NOTES)?.fieldValue || '',
          itemLocations: parseItemLocations(getField(fields, F_ITEM_LOCATIONS)?.fieldValue || ''),
        };
      })
      // Filter out cancelled jobs — plain "Cancelled" (162) AND same-day "Cancelled - Today" (163, a
      // different optionID); match by status text so all cancelled variants drop (completed jobs are KEPT).
      // Exception: includeCancelled keeps them (flagged isCancelled) so the geofence sync can deactivate
      // a same-day cancel's geofence immediately.
      .filter((wo) => includeCancelled || (wo.statusOptionID !== STATUS_CANCELLED && !/cancel/i.test(String(wo.status || ''))))
      // Filter out Urgent Call Back (UCB) route jobs
      .filter((wo) => !/URGENTCB/i.test(wo.route))
      // Require a jobID
      .filter((wo) => wo.jobID)
      // Sort by appointment time ascending
      .sort((a, b) => a.time - b.time);

    // Geocode jobs (only when asked) so the truck map can drop house pins. Includes COMPLETED jobs now
    // (they render grayed on the map), so geocode every job with an address — not just open ones.
    // Cache-first via geocode_cache. Google (rooftop) is the PRIMARY geocoder; Census is a fallback on a
    // transient Google failure. A cached row is trusted ONLY if provider='google' — Census-sourced or
    // missing rows get (re)geocoded with Google, so old inaccurate Census pins auto-upgrade on next fetch.
    if (includeCoords) {
      const GKEY = Deno.env.get('GOOGLE_GEOCODING_API_KEY') || Deno.env.get('GOOGLE_MAPS_API_KEY') || '';
      const toGeocode = workOrders.filter((w) => w.address);
      await Promise.all(toGeocode.map(async (w) => {
        const oneLine = w.address.replace(/\n/g, ', ').replace(/\s+/g, ' ').trim();
        const key = oneLine.toLowerCase();
        try {
          const { data: cached } = await supabase
            .from('geocode_cache')
            .select('lat, lon, found, provider')
            .eq('address_key', key)
            .maybeSingle();
          if (cached && cached.provider === 'google') {
            if (cached.found) { w.lat = cached.lat; w.lon = cached.lon; }
            return;
          }
          // Google first (rooftop). Census only if Google errors transiently (so we retry Google later).
          let provider = 'google';
          let g: { found: boolean; lat?: number; lon?: number } | null = GKEY ? await geocodeGoogle(GKEY, oneLine) : null;
          if (g === null) {
            const c = await geocodeCensus(oneLine);
            provider = 'census';
            g = c ? { found: true, lat: c.lat, lon: c.lon } : { found: false };
          }
          await supabase.from('geocode_cache').upsert({
            address_key: key,
            lat: g.found ? g.lat : null,
            lon: g.found ? g.lon : null,
            found: g.found,
            provider,
            updated_at: new Date().toISOString(),
          });
          if (g.found) { w.lat = g.lat; w.lon = g.lon; }
        } catch (e) {
          console.warn('[workorders] geocode failed for one job (non-fatal):', (e as Error).message);
        }
      }));
    }

    return new Response(JSON.stringify({
      success: true,
      workOrders,
      meta: {
        franchiseID,
        dayOffset,
        dateStart,
        dateEnd,
        rawCount: workOrdersRaw.length,
        filteredCount: workOrders.length,
      },
    }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });

  } catch (e) {
    const err = e as Error;
    return new Response(JSON.stringify({
      success: false,
      error: 'Unhandled error: ' + (err.message || String(e)),
      stack: err.stack || '',
    }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
