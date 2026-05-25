// Supabase Edge Function: crewlogic-estimate (v1.4)
// Estimate CRUD operations - fully replaces the n8n crewlogic-estimate webhook.
// Deploy: supabase functions deploy crewlogic-estimate
//
// Actions:
//   save           - upsert estimate to Supabase estimates table
//   calcDistances  - Google Maps Distance Matrix lookup for cost analysis routing
//   searchClients  - Vonigo client search (MD5 /security/login/ auth — no OAuth)
//   delete         - delete a submitted quote from Vonigo (POST /data/Quotes/ method 4)
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
//       the Vonigo quote removal. crewlogic-estimate now fully replaces the n8n
//       webhook — no actions remain in n8n for this endpoint.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const VONIGO_BASE = "https://junkluggers.vonigo.com/api/v1";
const TENANT_ID = "946a4535-aa61-45b6-a6fb-9190ff546d41"; // Junkluggers
const F_CLIENT_ADDRESS = 129; // Vonigo Client field: address
const F_CLIENT_CONTACT = 130; // Vonigo Client field: primary contact

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

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const ACTION_HANDLERS: Record<string, (body: Record<string, unknown>) => Promise<Response>> = {
  save: handleSave,
  calcDistances: handleCalcDistances,
  searchClients: handleSearchClients,
  delete: handleDelete,
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