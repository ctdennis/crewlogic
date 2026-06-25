// Supabase Edge Function: crewlogic-estimate (v1.5)
// Estimate operations - replaces the n8n crewlogic-estimate AND crewlogic-submit-quote webhooks.
// Deploy: supabase functions deploy crewlogic-estimate
//
// Actions:
//   save           - upsert estimate to Supabase estimates table
//   calcDistances  - Google Maps Distance Matrix lookup for cost analysis routing
//   searchClients  - Vonigo client search (MD5 /security/login/ auth — no OAuth)
//   delete         - delete a submitted quote from Vonigo (POST /data/Quotes/ method 4)
//   submitQuote    - create a Vonigo quote from an estimate (create + photo upload + field edit)
//
// SECRETS REQUIRED (auto-populated):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   GOOGLE_MAPS_API_KEY  (or fallback to GOOGLE_GEOCODING_API_KEY if Distance Matrix
//                         API is enabled on the same key)
//
// v1.2: Fixed calcDistances response shape to match the n8n contract the frontend
//       expects (flat keys: homeMiles, homeMinutes, disposalMiles, disposalMinutes,
//       recyclingMiles/Minutes, donationMiles/Minutes). v1.1 returned a nested object
//       with different keys, so the frontend couldn't read any of the values.
// v1.3: Added searchClients — migrated from n8n. Authenticates to Vonigo with the
//       same MD5 /security/login/ flow the other edge functions use (the prior
//       "requires Vonigo OAuth" note was incorrect — there is no OAuth). Vonigo
//       creds come from the vonigo_credentials Vault via get_vonigo_credential.
// v1.4: Added delete — migrated from n8n (same MD5 auth). Deletes the submitted
//       Vonigo quote by objectID (method 4). The CrewLogic-side soft-delete
//       (estimates.status='deleted') is done client-side; this action only handles
//       the Vonigo quote removal.
// v1.5: Added submitQuote — migrated from the n8n crewlogic-submit-quote webhook.
//       Creates a Vonigo quote (method 3) with the frontend-built Charges + Fields,
//       uploads each photo (fetch signed URL → base64 → /data/documents/), then
//       edits the quote (method 2) to set dwelling/parking/jobType option IDs.
//       Charges + option IDs are computed by the frontend and passed through.
//       (The frontend's pdfBase64 is intentionally ignored — n8n never uploaded it.)
// v1.6: submitQuote create-call hardening. (a) Sanitize ALL Vonigo text fields
//       (notes/itemsList/itemLocations) to ASCII via shared sanitizeVonigoText —
//       the create call previously only stripped •/em-dash and never touched
//       itemsList, so AI text with en-dashes/curly quotes triggered Vonigo's
//       generic "data validation failed". (b) On create failure, log the full
//       payload (securityToken redacted) + Vonigo's full response for diagnosis.
// v1.8: Graceful handling when Vonigo's create returns a non-JSON body (HTML error
//       page) — e.g. attaching to a job that already has an estimate. Previously the
//       server's .json() threw and "Unexpected token '<' ... is not valid JSON" leaked
//       to the UI; now we safe-parse the create response, log the raw body, and return
//       a plain message naming the job: "There is already an estimate assigned to Vonigo
//       job XXXXXX. To post this estimate from CrewLogic you will first need to remove the
//       estimate in Vonigo." (no Vonigo reason codes surfaced to the user).
// v1.7: Fix per-franchise tax handling. Charges historically defaulted to taxID 146
//       (the original franchise's "Non-Taxable" schedule); franchises on a different
//       tax schedule got Vonigo "-7207 Tax reference not found" and the whole quote
//       was rejected. applyLivePriceBookTaxIDs() now re-derives each charge's taxID
//       from the live price book (crewlogic-price-lookup, which returns taxID per
//       priceItemID) before create — also corrects older estimates' stale taxIDs.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logUsage } from "../_shared/usage.ts";

// Service-role client used ONLY for fire-and-forget usage metering (see _shared/usage.ts).
const _usageClient = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
// When "true" (set on DEV deployments only), every Vonigo WRITE action is refused so dev
// can never mutate the real (prod) Vonigo. Reads (searchClients, lookups) are unaffected.
const VONIGO_READONLY = Deno.env.get("VONIGO_READONLY") === "true";

const VONIGO_BASE = "https://junkluggers.vonigo.com/api/v1";
const TENANT_ID = "946a4535-aa61-45b6-a6fb-9190ff546d41"; // Junkluggers
const F_CLIENT_ADDRESS = 129; // Vonigo Client field: address
const F_CLIENT_CONTACT = 130; // Vonigo Client field: primary contact

// Base64-encode bytes in 32KB chunks (avoids call-stack overflow on large images).
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Vonigo itemLocations multi-checkbox string (fieldID 11215), derived from the
// estimate's areas. Mirrors the n8n encoding exactly.
function buildItemLocations(areas: unknown): string {
  const lows = (Array.isArray(areas) ? areas : []).map((a) => String(a || "").toLowerCase());
  const has = (s: string) => lows.some((a) => a.includes(s));
  const loc = [
    { id: 18910, label: "Basement", checked: has("basement") },
    { id: 18911, label: "1st Floor", checked: has("1st") || has("first") },
    { id: 18912, label: "2nd Floor", checked: has("2nd") || has("second") },
    { id: 18913, label: "3rd Floor", checked: has("3rd") || has("third") },
    { id: 18914, label: "Attic", checked: has("attic") },
    { id: 18915, label: "Outside/Garage", checked: has("outside") || has("garage") || has("curb") || has("driveway") },
  ];
  return loc
    .map((l, i) => l.id + "!~!" + l.label + "!`!" + (l.checked ? 1 : 0) + "!!" + (i < loc.length - 1 ? "~~!!" : "!~~~!!!"))
    .join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase REST helpers (use service role to bypass RLS)
// ─────────────────────────────────────────────────────────────────────────────
async function supabaseGet(path: string): Promise<unknown> {
  const res = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} failed: ${res.status}`);
  return res.json();
}

async function supabasePost(path: string, body: unknown, prefer: string = "return=minimal"): Promise<Response> {
  return fetch(SUPABASE_URL + path, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: JSON.stringify(body),
  });
}

async function supabasePatch(path: string, body: unknown, prefer: string = "return=minimal"): Promise<Response> {
  return fetch(SUPABASE_URL + path, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: JSON.stringify(body),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: save
// Mirrors the n8n "Prepare Supabase Payload" + SQL upsert, using PostgREST.
// ─────────────────────────────────────────────────────────────────────────────
async function handleSave(body: Record<string, unknown>): Promise<Response> {
  const email = body.email as string | undefined;
  const franchiseExternalId = String(body.franchiseID || "");
  const payload = (body.payload as Record<string, unknown>) || {};

  if (!email || !franchiseExternalId) {
    return jsonResponse({ success: false, error: "email and franchiseID required" }, 400);
  }
  if (!payload.estimateID) {
    return jsonResponse({ success: false, error: "payload.estimateID required" }, 400);
  }

  // DATA-LOSS GUARD: a legitimate editor save always sends a `charges` ARRAY (even an empty []),
  // because the in-editor estimate has one. A payload with NO charges array is the signature of a
  // partial/stale save (e.g. the status-button bug that re-saved a lightweight list object). Refuse
  // to overwrite an estimate that already HAS line items with such a payload — this can never blank a
  // record, and it protects against older client builds still open in browsers. Returns 409 so the
  // client surfaces an error instead of silently losing data. (Explicit "deleted everything" still
  // works: that arrives as charges:[] — an array — and passes.)
  if (!Array.isArray((payload as Record<string, unknown>).charges)) {
    const existing = await supabaseGet(
      `/rest/v1/estimates?estimate_id=eq.${encodeURIComponent(String(payload.estimateID))}&select=payload`
    ) as Array<Record<string, unknown>>;
    const existingCharges = existing && existing[0] &&
      ((existing[0].payload as Record<string, unknown>) || {}).charges;
    const existingCount = Array.isArray(existingCharges) ? existingCharges.length : 0;
    if (existingCount > 0) {
      console.error(`[save] BLOCKED charge-wipe for estimate ${payload.estimateID}: incoming payload has no charges array but the stored row has ${existingCount} line item(s).`);
      return jsonResponse({
        success: false,
        error: "charge_wipe_blocked",
        detail: `Refused to overwrite ${existingCount} existing line item(s) with a payload that has no charges. Reopen the estimate and save again.`,
      }, 409);
    }
  }

  // 1. Look up the franchise UUID via external_id
  const franchiseRows = await supabaseGet(
    `/rest/v1/franchises?external_id=eq.${encodeURIComponent(franchiseExternalId)}&select=id,tenant_id`
  ) as Array<Record<string, unknown>>;

  if (!franchiseRows || !franchiseRows.length) {
    return jsonResponse({ success: false, error: `Franchise not found: ${franchiseExternalId}` }, 404);
  }
  const franchiseUUID = franchiseRows[0].id as string;

  // 2. Build the row (mirrors n8n "Prepare Supabase Payload" node)
  let costAnalysis: unknown = {};
  try {
    costAnalysis = typeof body.costAnalysis === "string"
      ? JSON.parse(body.costAnalysis as string)
      : (body.costAnalysis || {});
  } catch (_e) {
    costAnalysis = {};
  }

  let priceBook: unknown = [];
  try {
    if (Array.isArray(body.priceBook)) {
      priceBook = body.priceBook;
    } else if (typeof body.priceBook === "string" && (body.priceBook as string).length > 2) {
      priceBook = JSON.parse(body.priceBook as string);
    }
  } catch (_e) {
    priceBook = [];
  }

  const row: Record<string, unknown> = {
    estimate_id: payload.estimateID,
    franchise_id: franchiseUUID,
    owner_email: email,
    label: (payload.label as string) || "",
    status: (payload.status as string) || "draft",
    client_name: (payload.clientName as string) || "",
    address: (payload.address as string) || "",
    zip: (payload.zip as string) || "",
    total_price: parseFloat(payload.totalPrice as string) || 0,
    total_trucks: parseFloat(payload.totalTrucks as string) || 0,
    split_pricing: !!payload.splitPricing,
    vonigo_quote_id: payload.vonigoQuoteID ? parseInt(String(payload.vonigoQuoteID)) : null,
    job_id: payload.jobID || null,
    client_id: payload.clientID || null,
    contact_id: payload.contactID || null,
    location_id: payload.locationID || null,
    client_phone: payload.clientPhone || null,
    cover_photo: (body.coverPhoto as string) || (payload.coverPhoto as string) || "",
    payload: payload,
    price_book: priceBook,
    cost_analysis: costAnalysis,
    cloned_from: payload.clonedFrom ? parseInt(String(payload.clonedFrom)) : null,
    created_at: payload.createdAt || new Date().toISOString(),
    updated_at: payload.updatedAt || new Date().toISOString(),
  };

  // 3. Upsert via PostgREST. on_conflict=estimate_id, return=minimal for speed.
  // Prefer header "resolution=merge-duplicates" tells PostgREST to do an UPSERT.
  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/estimates?on_conflict=estimate_id`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  });

  if (!upsertRes.ok) {
    const errText = await upsertRes.text().catch(() => "");
    console.error("Estimate upsert failed:", upsertRes.status, errText);
    return jsonResponse(
      { success: false, error: `DB error ${upsertRes.status}: ${errText.slice(0, 500)}` },
      500
    );
  }

  // Phase 3 (dual-write): mirror the line items into the estimate_charges table so it stays in sync
  // with the blob, ahead of the read cut-over. BEST-EFFORT — any failure here is logged and ignored;
  // it must NEVER block the save (the blob remains the source of truth until cut-over). Delete-then-
  // insert is the simplest correct sync for an estimate's full charge set. (The charge-wipe guard
  // above already rejected payloads missing the charges array, so we only get here with a real set.)
  try {
    const chargesArr = Array.isArray((payload as Record<string, unknown>).charges)
      ? ((payload as Record<string, unknown>).charges as Array<Record<string, unknown>>)
      : [];
    const numOrNull = (v: unknown) =>
      (v === null || v === undefined || v === "" ) ? null
      : (typeof v === "number" ? v : (isNaN(Number(v)) ? null : Number(v)));
    await fetch(
      `${SUPABASE_URL}/rest/v1/estimate_charges?estimate_id=eq.${encodeURIComponent(String(payload.estimateID))}`,
      { method: "DELETE", headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, Prefer: "return=minimal" } }
    );
    if (chargesArr.length) {
      const rows = chargesArr.map((c, i) => ({
        estimate_id: payload.estimateID,
        franchise_id: franchiseUUID,
        sequence: i,
        type: (c.type as string) ?? null,
        area: (c.area as string) ?? null,
        room: (c.room as string) ?? null,
        name: (c.name as string) ?? null,
        description: (c.description as string) ?? null,
        qty: numOrNull(c.qty),
        unit_price: numOrNull(c.unitPrice),
        truck_volume: numOrNull(c.truckVolume),
        data: c,
      }));
      const insRes = await fetch(`${SUPABASE_URL}/rest/v1/estimate_charges`, {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(rows),
      });
      if (!insRes.ok) {
        const t = await insRes.text().catch(() => "");
        console.error(`[save] estimate_charges dual-write insert failed (non-fatal): ${insRes.status} ${t.slice(0, 300)}`);
      }
    }
  } catch (e) {
    console.error("[save] estimate_charges dual-write failed (non-fatal):", (e as Error).message);
  }

  return jsonResponse({
    success: true,
    estimateID: payload.estimateID,
    franchiseID: franchiseUUID,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: calcDistances
// Replaces n8n calcDistances action. Uses Google Maps Distance Matrix API.
// Body: { truckHome, jobSite, disposalSite, recyclingSite?, donationSite? }
// Returns: { success, distances: {
//   homeMiles, homeMinutes,         // Home → Job
//   disposalMiles, disposalMinutes, // Job → Disposal
//   recyclingMiles, recyclingMinutes, // Job → Recycling (if present)
//   donationMiles, donationMinutes,   // Job → Donation (if present)
// } }
// Shape matches the original n8n contract that the frontend expects.
// ─────────────────────────────────────────────────────────────────────────────
async function handleCalcDistances(body: Record<string, unknown>): Promise<Response> {
  const apiKey = Deno.env.get("GOOGLE_MAPS_API_KEY") || Deno.env.get("GOOGLE_GEOCODING_API_KEY");
  if (!apiKey) {
    return jsonResponse(
      { success: false, error: "GOOGLE_MAPS_API_KEY not configured. Set it in Edge Function secrets." },
      500
    );
  }

  const truckHome    = String(body.truckHome    || "").trim();
  const jobSite      = String(body.jobSite      || "").trim();
  const disposalSite = String(body.disposalSite || "").trim();
  const recyclingSite = body.recyclingSite ? String(body.recyclingSite).trim() : "";
  const donationSite  = body.donationSite  ? String(body.donationSite).trim()  : "";

  if (!truckHome || !jobSite || !disposalSite) {
    return jsonResponse({ success: false, error: "truckHome, jobSite, disposalSite required" }, 400);
  }

  // Build a single Distance Matrix call with multiple destinations from a single origin.
  // We need: Home→Job, Job→Disposal, Job→Recycling (optional), Job→Donation (optional).
  // The most efficient single call: origins = [truckHome, jobSite],
  // destinations = [jobSite, disposalSite, recyclingSite?, donationSite?]
  const origins = [truckHome, jobSite];
  const destinations: string[] = [jobSite, disposalSite];
  if (recyclingSite) destinations.push(recyclingSite);
  if (donationSite)  destinations.push(donationSite);

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${origins.map(encodeURIComponent).join("|")}` +
    `&destinations=${destinations.map(encodeURIComponent).join("|")}` +
    `&units=imperial` +
    `&key=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) {
    return jsonResponse({ success: false, error: `Google Maps API ${res.status}` }, 502);
  }
  const data = await res.json() as {
    status: string;
    rows?: Array<{ elements: Array<{ status: string; distance?: { value: number; text: string }; duration?: { value: number; text: string } }> }>;
    error_message?: string;
  };

  if (data.status !== "OK") {
    return jsonResponse(
      { success: false, error: `Google Maps API: ${data.status}${data.error_message ? " — " + data.error_message : ""}` },
      502
    );
  }

  // Helper to extract miles and minutes from a matrix cell. Returns null if cell failed.
  function extract(originIdx: number, destIdx: number): { miles: number; minutes: number } | null {
    const cell = data.rows?.[originIdx]?.elements?.[destIdx];
    if (!cell || cell.status !== "OK" || !cell.distance || !cell.duration) return null;
    return {
      miles:   Math.round((cell.distance.value / 1609.344) * 10) / 10,  // meters → miles, 1 decimal
      minutes: Math.round(cell.duration.value / 60),                    // seconds → whole minutes
    };
  }

  // origins: 0 = truckHome, 1 = jobSite
  // destinations: 0 = jobSite, 1 = disposalSite, 2 = recyclingSite?, 3 = donationSite?
  const distances: Record<string, number> = {};

  const homeToJob = extract(0, 0);
  if (homeToJob) {
    distances.homeMiles   = homeToJob.miles;
    distances.homeMinutes = homeToJob.minutes;
  }

  const jobToDisposal = extract(1, 1);
  if (jobToDisposal) {
    distances.disposalMiles   = jobToDisposal.miles;
    distances.disposalMinutes = jobToDisposal.minutes;
  }

  if (recyclingSite) {
    const jobToRecycling = extract(1, 2);
    if (jobToRecycling) {
      distances.recyclingMiles   = jobToRecycling.miles;
      distances.recyclingMinutes = jobToRecycling.minutes;
    }
  }

  if (donationSite) {
    // Donation index depends on whether recycling was included
    const donationDestIdx = recyclingSite ? 3 : 2;
    const jobToDonation = extract(1, donationDestIdx);
    if (jobToDonation) {
      distances.donationMiles   = jobToDonation.miles;
      distances.donationMinutes = jobToDonation.minutes;
    }
  }

  // Meter the billed Google Distance Matrix call. units = billed elements (origins ×
  // destinations). franchiseInternalID/tenantID are passed by the frontend (UUIDs); the
  // external `franchiseID` ("90") would coerce to null in usage_events (uuid column).
  // Non-blocking: logUsage never throws.
  await logUsage(_usageClient, {
    tenantId: body.tenantID as string | undefined,
    franchiseId: (body.franchiseInternalID ?? body.franchiseID) as string | undefined,
    eventType: "maps.distance_matrix",
    model: null,
    units: origins.length * destinations.length,
    metadata: { elements: origins.length * destinations.length },
  });

  return jsonResponse({ success: true, distances });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Vonigo auth — resolve franchise + creds, MD5 /security/login/ → securityToken.
// Same flow as crewlogic-todays-workorders / crewlogic-job-lookup (no OAuth).
// ─────────────────────────────────────────────────────────────────────────────
async function vonigoLogin(franchiseExternalId: string): Promise<string> {
  // Use the supabase-js client for the franchise lookup + credential RPC — same
  // proven path as crewlogic-job-lookup. (The vonigo_md5 value lives in Vault and
  // is only reachable via get_vonigo_credential, NOT a direct table select.)
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: franchiseRow, error: frErr } = await supabase
    .from("franchises")
    .select("id")
    .eq("external_id", franchiseExternalId)
    .eq("tenant_id", TENANT_ID)
    .single();
  if (frErr || !franchiseRow) {
    throw new Error("Franchise not found: " + franchiseExternalId);
  }

  let creds: { vonigo_username: string; vonigo_md5: string } | null = null;
  const { data: credRows, error: credErr } = await supabase
    .rpc("get_vonigo_credential", { franchise_id_param: franchiseRow.id });
  if (!credErr && credRows && credRows.length > 0) {
    creds = credRows[0];
  } else {
    for (const paramName of ["p_franchise_id", "franchise_id", "franchiseid", "fid"]) {
      const args: Record<string, string> = {};
      args[paramName] = franchiseRow.id;
      const r = await supabase.rpc("get_vonigo_credential", args);
      if (!r.error && r.data && r.data.length > 0) { creds = r.data[0]; break; }
    }
  }
  if (!creds) throw new Error("Vonigo credentials not found for franchise " + franchiseExternalId);

  const authUrl = new URL(VONIGO_BASE + "/security/login/");
  authUrl.searchParams.set("company", "Vonigo");
  authUrl.searchParams.set("userName", creds.vonigo_username);
  authUrl.searchParams.set("password", creds.vonigo_md5);
  const authData = await (await fetch(authUrl.toString())).json();
  if (authData.errNo !== 0 || !authData.securityToken) {
    throw new Error("Vonigo auth failed: " + (authData.errMsg || "no token"));
  }
  return authData.securityToken as string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: searchClients
// Vonigo client search by name/term. Mirrors the n8n searchClients action.
// ─────────────────────────────────────────────────────────────────────────────
async function handleSearchClients(body: Record<string, unknown>): Promise<Response> {
  const franchiseExternalId = String(body.franchiseID || "");
  const searchPar = String(body.searchPar || "").trim();
  if (!franchiseExternalId) return jsonResponse({ success: false, error: "franchiseID required" }, 400);
  if (!searchPar) return jsonResponse({ success: false, error: "searchPar required" }, 400);

  const securityToken = await vonigoLogin(franchiseExternalId);

  const res = await fetch(VONIGO_BASE + "/data/Clients/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      securityToken,
      method: "0",
      pageNo: "1",
      pageSize: "20",
      sortMode: "1",
      sortDirection: "0",
      isCompleteObject: "true",
      searchPar,
    }),
  });
  const data = await res.json();

  // Match the n8n behavior: any non-result (errNo, empty) is just "no clients".
  if (data.errNo !== 0) {
    console.warn(`[searchClients] Vonigo errNo ${data.errNo}: ${data.errMsg || ""} (searchPar "${searchPar}")`);
    return jsonResponse({ success: true, clients: [] });
  }

  const clients = ((data.Clients || []) as Array<Record<string, unknown>>).map((c) => {
    const fields = (c.Fields || []) as Array<{ fieldID: number | string; fieldValue: string | null }>;
    const address = fields.find((f) => String(f.fieldID) === String(F_CLIENT_ADDRESS))?.fieldValue || "";
    const contact = fields.find((f) => String(f.fieldID) === String(F_CLIENT_CONTACT))?.fieldValue || "";
    const zipMatch = address.match(/\b(\d{5})\b/);
    return {
      clientID: c.objectID,
      name: c.name,
      address,
      contact,
      zip: zipMatch ? zipMatch[1] : "",
    };
  });

  return jsonResponse({ success: true, clients });
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: delete
// Deletes a submitted quote from Vonigo (method 4). Mirrors the n8n delete action.
// The CrewLogic-side soft-delete (estimates.status='deleted') is done client-side
// before this is called; this only removes the Vonigo quote. Best-effort by design
// (the frontend tolerates failure since the estimate is already archived locally).
// ─────────────────────────────────────────────────────────────────────────────
async function handleDelete(body: Record<string, unknown>): Promise<Response> {
  if (VONIGO_READONLY) return jsonResponse({ success: false, error: "Vonigo writes are disabled in this environment (dev is read-only). Delete from Vonigo only in production." }, 403);
  const franchiseExternalId = String(body.franchiseID || "");
  const vonigoQuoteID = body.vonigoQuoteID;
  if (!franchiseExternalId) return jsonResponse({ success: false, error: "franchiseID required" }, 400);
  // No Vonigo quote → nothing to delete in Vonigo (estimate was never submitted).
  if (!vonigoQuoteID) {
    return jsonResponse({ success: true, deleted: false, note: "no vonigoQuoteID — nothing to delete in Vonigo" });
  }

  const securityToken = await vonigoLogin(franchiseExternalId);

  const res = await fetch(VONIGO_BASE + "/data/Quotes/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ securityToken, method: "4", objectID: vonigoQuoteID }),
  });
  const data = await res.json();
  if (data.errNo !== 0) {
    console.warn(`[delete] Vonigo errNo ${data.errNo}: ${data.errMsg || ""} (quote ${vonigoQuoteID})`);
    return jsonResponse({ success: false, error: `Vonigo delete failed: ${data.errMsg || "errNo " + data.errNo}` }, 502);
  }
  return jsonResponse({ success: true, deleted: true, vonigoQuoteID });
}

// Vonigo's API rejects non-ASCII text field values with a generic "data validation
// failed" error. AI-generated notes/itemsList routinely contain en/em dashes, curly
// quotes, bullets and ellipses (e.g. "2–3 pieces"), so normalize the common ones to
// ASCII and strip anything still non-ASCII. Both the create and edit calls use this.
function sanitizeVonigoText(s: unknown): string {
  return String(s ?? "")
    .replace(/[•·]/g, "-")
    .replace(/[—–]/g, "-")            // em/en dash → hyphen
    .replace(/[‘’‚‛]/g, "'")  // curly single quotes
    .replace(/[“”„‟]/g, '"')  // curly double quotes
    .replace(/…/g, "...")        // ellipsis
    .replace(/[^\x00-\x7F]/g, "");    // drop any remaining non-ASCII
}

// Override each charge's taxID with the franchise's live per-item tax schedule, looked
// up from crewlogic-price-lookup (which returns taxID per priceItemID). Vonigo rejects a
// quote when a charge's taxID isn't a valid tax reference for that franchise. Best-effort:
// any lookup failure or unmatched item leaves that charge's taxID unchanged.
async function applyLivePriceBookTaxIDs(
  franchiseID: string,
  zip: string,
  charges: unknown,
): Promise<unknown> {
  if (!Array.isArray(charges) || !franchiseID || !zip) return charges;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/crewlogic-price-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}`, "apikey": SERVICE_KEY },
      body: JSON.stringify({ franchiseID, zipCode: zip }),
    });
    const data = await res.json();
    if (!data?.success || !Array.isArray(data.blocks)) return charges;
    const taxByItemID: Record<string, number> = {};
    for (const b of data.blocks) {
      for (const it of (b.items || [])) {
        if (it?.priceItemID != null && it?.taxID != null) taxByItemID[String(it.priceItemID)] = it.taxID;
      }
    }
    return charges.map((c) => {
      const id = (c as Record<string, unknown>)?.priceItemID;
      const t = taxByItemID[String(id)];
      return t != null ? { ...(c as Record<string, unknown>), taxID: String(t) } : c;
    });
  } catch (_e) {
    return charges;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: submitQuote
// Creates a Vonigo quote from an estimate and uploads its photos. Mirrors the n8n
// crewlogic-submit-quote workflow: create (method 3) → upload photos → edit (method 2).
// Charges + option IDs are pre-built by the frontend and passed through. The
// frontend's pdfBase64 is intentionally ignored (n8n never uploaded it).
// ─────────────────────────────────────────────────────────────────────────────
async function handleSubmitQuote(body: Record<string, unknown>): Promise<Response> {
  if (VONIGO_READONLY) return jsonResponse({ success: false, error: "Vonigo writes are disabled in this environment (dev is read-only). Submit to Vonigo only in production." }, 403);
  const franchiseExternalId = String(body.franchiseID || "");
  const clientID = body.clientID;
  const contactID = body.contactID;
  const locationID = body.locationID;
  if (!franchiseExternalId) return jsonResponse({ success: false, error: "franchiseID required" }, 400);
  if (!clientID || !contactID || !locationID) {
    return jsonResponse({ success: false, error: "clientID, contactID and locationID required" }, 400);
  }

  const securityToken = await vonigoLogin(franchiseExternalId);
  const itemLocations = sanitizeVonigoText(buildItemLocations(body.areas));
  const notesCreate = sanitizeVonigoText(body.customerSituation || body.notes || "");
  const itemsList = sanitizeVonigoText(body.itemsList || "");

  // Re-derive each charge's tax schedule from the LIVE Vonigo price book. Tax references
  // are per-franchise: a wrong/placeholder taxID (the frontend historically defaulted to
  // 146 = the original franchise's "Non-Taxable" schedule) makes Vonigo reject the whole
  // quote with "Tax reference not found" for franchises on a different schedule. Pulling
  // taxID per priceItemID here fixes that — and also corrects older estimates whose stored
  // charges still carry a stale taxID. Best-effort: if the lookup fails, charges pass through.
  const charges = await applyLivePriceBookTaxIDs(franchiseExternalId, String(body.zip || ""), body.charges);

  // 1) Create the quote (method 3). Charges are pre-built by the frontend.
  const createBody: Record<string, unknown> = {
    securityToken,
    method: "3",
    clientID,
    contactID,
    locationID,
    serviceTypeID: "11",
    Fields: [
      { fieldID: 914, fieldValue: notesCreate },
      { fieldID: 10336, fieldValue: itemsList },
      { fieldID: 11215, fieldValue: itemLocations },
    ],
    Charges: charges,
  };
  if (body.jobID) createBody.jobID = body.jobID;

  const createResp = await fetch(VONIGO_BASE + "/data/Quotes/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createBody),
  });
  // Vonigo sometimes returns a non-JSON body (an HTML error page) instead of its usual
  // { errNo, ... } — most commonly when attaching a quote to a job that already has an
  // estimate. Parse defensively so a JSON.parse error ("Unexpected token '<'") never
  // leaks to the UI; surface a clear, actionable message instead.
  const createRaw = await createResp.text();
  // deno-lint-ignore no-explicit-any
  let createData: any;
  try {
    createData = JSON.parse(createRaw);
  } catch {
    console.error(`[submitQuote] create returned non-JSON (HTTP ${createResp.status}): ${createRaw.slice(0, 600)}`);
    console.error(`[submitQuote] create payload: ${JSON.stringify({ ...createBody, securityToken: "[redacted]" })}`);
    const msg = createBody.jobID
      ? `There is already an estimate assigned to Vonigo job ${createBody.jobID}. To post this estimate from CrewLogic you will first need to remove the estimate in Vonigo.`
      : "CrewLogic couldn't post this estimate to Vonigo. Please try again, or check the job in Vonigo.";
    return jsonResponse({ success: false, error: msg }, 502);
  }
  if (createData.errNo !== 0 || !createData.Quote) {
    console.error(`[submitQuote] create failed errNo ${createData.errNo}: ${createData.errMsg || ""}`);
    // Log the full payload (token redacted) + Vonigo's full response so a generic
    // "data validation failed" can be traced to the exact field/charge next time.
    console.error(`[submitQuote] create payload: ${JSON.stringify({ ...createBody, securityToken: "[redacted]" })}`);
    console.error(`[submitQuote] create response: ${JSON.stringify(createData)}`);
    return jsonResponse({ success: false, error: createData.errMsg || `Vonigo create failed (errNo ${createData.errNo})` }, 502);
  }
  const quoteID = createData.Quote.objectID;

  // 2) Upload photos (best-effort — the quote already exists; a photo failure
  //    shouldn't fail the whole submission). Fetch each signed URL → base64 → Vonigo.
  const photos = (Array.isArray(body.photos) ? body.photos : []) as Array<{ signedUrl?: string; room?: string }>;
  let photosUploaded = 0;
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    if (!p || !p.signedUrl) continue;
    try {
      const imgRes = await fetch(p.signedUrl);
      if (!imgRes.ok) { console.warn(`[submitQuote] photo ${i + 1} fetch ${imgRes.status}`); continue; }
      const base64 = uint8ToBase64(new Uint8Array(await imgRes.arrayBuffer()));
      const fileName = (p.room || "Room").replace(/[^a-z0-9]/gi, "_") + "_" + (i + 1) + ".jpg";
      const upData = await (await fetch(VONIGO_BASE + "/data/documents/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ securityToken, quoteID, method: "3", fileName, file64BitBase: base64 }),
      })).json();
      if (upData.errNo === 0) photosUploaded++;
      else console.warn(`[submitQuote] photo ${i + 1} upload errNo ${upData.errNo}: ${upData.errMsg || ""}`);
    } catch (e) {
      console.warn(`[submitQuote] photo ${i + 1} error: ${(e as Error).message}`);
    }
  }

  // 3) Edit quote fields (method 2) — set option-ID fields + sanitized notes.
  const notesEdit = sanitizeVonigoText(body.customerSituation || body.notes || "");
  const editData = await (await fetch(VONIGO_BASE + "/data/Quotes/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      securityToken,
      method: "2",
      objectID: quoteID,
      Fields: [
        { fieldID: 914, fieldValue: notesEdit },
        { fieldID: 10726, optionID: body.dwellingTypeOptionID || 11227 },
        { fieldID: 10258, optionID: body.parkingOptionID || 10450 },
        { fieldID: 10765, optionID: body.jobTypeOptionID || 12172 },
        { fieldID: 11215, fieldValue: itemLocations },
      ],
    }),
  })).json();
  if (editData.errNo !== 0) {
    // Non-fatal: the quote exists; field edit failure just means option IDs didn't set.
    console.warn(`[submitQuote] edit fields errNo ${editData.errNo}: ${editData.errMsg || ""} (quote ${quoteID} created OK)`);
  }

  return jsonResponse({ success: true, quoteID, photosUploaded });
}

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// HANDLER: pointDistance — generic origin→dest driving distance + ETA (lat,lon strings).
// Used by the Where-Are-My-Trucks "measure to a job" tap (truck location → a job marker).
async function handlePointDistance(body: Record<string, unknown>): Promise<Response> {
  const apiKey = Deno.env.get("GOOGLE_MAPS_API_KEY") || Deno.env.get("GOOGLE_GEOCODING_API_KEY");
  if (!apiKey) return jsonResponse({ success: false, error: "GOOGLE_MAPS_API_KEY not configured" }, 500);
  const origin = String(body.origin || "").trim();
  const dest = String(body.dest || "").trim();
  if (!origin || !dest) return jsonResponse({ success: false, error: "origin and dest required (as 'lat,lon')" }, 400);
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(dest)}&units=imperial&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return jsonResponse({ success: false, error: `Google Maps API ${res.status}` }, 502);
  const data = await res.json() as { status: string; rows?: Array<{ elements: Array<{ status: string; distance?: { value: number; text: string }; duration?: { value: number; text: string } }> }>; error_message?: string };
  if (data.status !== "OK") return jsonResponse({ success: false, error: `Google Maps API: ${data.status}` }, 502);
  const cell = data.rows?.[0]?.elements?.[0];
  if (!cell || cell.status !== "OK" || !cell.distance || !cell.duration) return jsonResponse({ success: false, error: "No route found" });
  return jsonResponse({
    success: true,
    miles: Math.round((cell.distance.value / 1609.344) * 10) / 10,
    minutes: Math.round(cell.duration.value / 60),
    distanceText: cell.distance.text,
    durationText: cell.duration.text,
  });
}

const ACTION_HANDLERS: Record<string, (body: Record<string, unknown>) => Promise<Response>> = {
  save: handleSave,
  calcDistances: handleCalcDistances,
  pointDistance: handlePointDistance,
  searchClients: handleSearchClients,
  delete: handleDelete,
  submitQuote: handleSubmitQuote,
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SERVE
// ─────────────────────────────────────────────────────────────────────────────
serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch (_e) {
    return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
  }

  const action = body.action as string;
  if (!action) {
    return jsonResponse({ success: false, error: "action required" }, 400);
  }

  const handler = ACTION_HANDLERS[action];
  if (!handler) {
    return jsonResponse({ success: false, error: `Unknown action: ${action}` }, 400);
  }

  try {
    return await handler(body);
  } catch (e) {
    const err = e as Error;
    console.error("crewlogic-estimate error:", err);
    return jsonResponse({ success: false, error: err.message || "Internal error" }, 500);
  }
});