// Supabase Edge Function: crewlogic-settings (v1.3)
// Settings save router - replaces n8n crewlogic-settings webhook.
// Deploy: supabase functions deploy crewlogic-settings
//
// v1.1: saveVonigoCredentials does Vonigo authentication + franchise
//   discovery (from the Vonigo Session block).
// v1.2: Include `slug` when creating a new tenant. [SUPERSEDED by v1.3]
// v1.3: CORRECT TENANCY MODEL — all Junkluggers franchises share ONE tenant
//   (Junkluggers brand). Do NOT create a new tenant per franchisee.
//   Credentials saved via upsert_vonigo_credential RPC (which handles Vault
//   storage of the MD5). franchises.vonigo_configured set true after save.
//
// Actions:
//   saveVonigoCredentials  - encrypt+store Vonigo username/password in franchises table
//   saveFranchiseInfo      - update franchise contact info (top-level + costSettings mirror)
//   saveCostSettings       - merge cost-tab fields into franchise.cost_settings JSONB
//   saveProposalSettings   - merge proposal fields into franchise.cost_settings JSONB
//   saveSignsConfig        - merge full costSettings (yard signs config inside) JSONB
//   saveSettings           - generic save: merge any provided fields into cost_settings + top-level
//   getFacilities          - read disposal/recycling/donation sites + hours + holidays from the
//                            relational tables (migration 0023), returned in the UI's in-memory shape
//   saveFacilities         - replace-set the franchise's facilities/facility_hours/franchise_holidays
//   listGeofences          - the franchise's own cached telematics geofences, for the facility
//                            picker that links a facility to a stable geofence id
//                            (moved out of the cost_settings JSONB blob)
//
// SECRETS REQUIRED (auto-populated by Supabase):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchTrucks } from "../_shared/telematics.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

// ─────────────────────────────────────────────────────────────────────────────
// Supabase REST helpers (service role bypasses RLS)
// ─────────────────────────────────────────────────────────────────────────────
async function supabaseGet(path: string): Promise<unknown> {
  const res = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} failed: ${res.status}`);
  return res.json();
}

async function supabasePatch(path: string, body: unknown): Promise<Response> {
  return fetch(SUPABASE_URL + path, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
}

async function supabasePost(path: string, body: unknown): Promise<Response> {
  return fetch(SUPABASE_URL + path, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
}

async function supabaseDelete(path: string): Promise<Response> {
  return fetch(SUPABASE_URL + path, {
    method: "DELETE",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      Prefer: "return=minimal",
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Look up franchise UUID + tenant_id by external_id
// ─────────────────────────────────────────────────────────────────────────────
async function lookupFranchise(externalID: string): Promise<{ id: string; tenant_id: string }> {
  const rows = (await supabaseGet(
    `/rest/v1/franchises?external_id=eq.${encodeURIComponent(externalID)}&select=id,tenant_id`
  )) as Array<Record<string, unknown>>;
  if (!rows || !rows.length) {
    throw new Error(`Franchise not found: ${externalID}`);
  }
  return { id: rows[0].id as string, tenant_id: rows[0].tenant_id as string };
}

// Same as lookupFranchise but returns null instead of throwing when not found.
// Used for franchise discovery (we want to know if it exists, not error out).
async function lookupFranchiseOrNull(externalID: string): Promise<{ id: string; tenant_id: string } | null> {
  const rows = (await supabaseGet(
    `/rest/v1/franchises?external_id=eq.${encodeURIComponent(externalID)}&select=id,tenant_id`
  )) as Array<Record<string, unknown>>;
  if (!rows || !rows.length) return null;
  return { id: rows[0].id as string, tenant_id: rows[0].tenant_id as string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Vonigo authentication — returns the full Session block so we can discover
// the user's franchise number. Used for guest-tester onboarding when the
// franchise external_id isn't known yet.
// ─────────────────────────────────────────────────────────────────────────────
interface VonigoSession {
  franchiseID: string;
  franchiseName: string;
  userID: string;
  securityToken: string;
}

async function vonigoLoginAndDiscover(username: string, md5: string): Promise<VonigoSession> {
  const url = new URL("https://junkluggers.vonigo.com/api/v1/security/login/");
  url.searchParams.set("company", "Vonigo");
  url.searchParams.set("userName", username);
  url.searchParams.set("password", md5);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.errNo !== 0 || !data.securityToken) {
    throw new Error("Vonigo authentication failed: " + (data.errMsg || "no token"));
  }
  if (!data.Session || !data.Session.franchiseID) {
    throw new Error("Vonigo response missing franchise info");
  }
  return {
    franchiseID: String(data.Session.franchiseID),
    franchiseName: String(data.Session.franchiseName || ""),
    userID: String(data.Session.userID || ""),
    securityToken: String(data.securityToken),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Look up an existing profile by email
// ─────────────────────────────────────────────────────────────────────────────
async function lookupProfileByEmail(email: string): Promise<{ id: string; franchise_id: string | null; role: string; pending_trial_ends_at: string | null } | null> {
  const rows = (await supabaseGet(
    `/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=id,franchise_id,role,pending_trial_ends_at`
  )) as Array<Record<string, unknown>>;
  if (!rows || !rows.length) return null;
  return {
    id: rows[0].id as string,
    franchise_id: rows[0].franchise_id as string | null,
    role: rows[0].role as string,
    pending_trial_ends_at: (rows[0].pending_trial_ends_at as string | null) ?? null,
  };
}

// Find the owner of a franchise — used to check whether another user has
// already claimed it. Returns the FIRST owner's email if any exist.
async function findFranchiseOwnerEmail(franchiseUUID: string): Promise<string | null> {
  const rows = (await supabaseGet(
    `/rest/v1/profiles?franchise_id=eq.${franchiseUUID}&role=eq.owner&select=email&limit=1`
  )) as Array<{ email: string }>;
  return rows && rows[0] ? rows[0].email : null;
}

// Reference franchise UUID for tools seeding (your franchise 90 — copy these
// 23 tools as the starter set for any newly created guest franchise).
const REFERENCE_TENANT_ID = "946a4535-aa61-45b6-a6fb-9190ff546d41";
const REFERENCE_FRANCHISE_EXTERNAL_ID = "90";

async function seedToolsFromReference(
  newTenantID: string,
  newFranchiseID: string,
): Promise<number> {
  // Look up reference franchise UUID
  const refFranchise = await lookupFranchiseOrNull(REFERENCE_FRANCHISE_EXTERNAL_ID);
  if (!refFranchise) {
    console.warn("[seedTools] Reference franchise 90 not found — skipping seed");
    return 0;
  }
  // Fetch all reference tools
  const refTools = (await supabaseGet(
    `/rest/v1/tools?franchise_id=eq.${refFranchise.id}&select=name,category,description,use_case,is_on_truck,is_active`
  )) as Array<Record<string, unknown>>;
  if (!refTools || refTools.length === 0) {
    console.warn("[seedTools] No tools in reference franchise — nothing to seed");
    return 0;
  }
  // Insert copies for the new franchise
  const rows = refTools.map((t) => ({
    tenant_id: newTenantID,
    franchise_id: newFranchiseID,
    name: t.name,
    category: t.category,
    description: t.description,
    use_case: t.use_case,
    is_on_truck: t.is_on_truck,
    is_active: t.is_active,
  }));
  const res = await supabasePost("/rest/v1/tools", rows);
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("[seedTools] Insert failed:", res.status, errText);
    return 0;
  }
  return rows.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Look up franchise UUID + tenant_id by external_id (original, throws if not found)

// ─────────────────────────────────────────────────────────────────────────────
// Read current cost_settings for a franchise (so we can merge instead of replace)
// ─────────────────────────────────────────────────────────────────────────────
async function getCurrentCostSettings(franchiseUUID: string): Promise<Record<string, unknown>> {
  const rows = (await supabaseGet(
    `/rest/v1/franchises?id=eq.${franchiseUUID}&select=cost_settings`
  )) as Array<{ cost_settings: Record<string, unknown> | null }>;
  return rows && rows[0] ? (rows[0].cost_settings || {}) : {};
}

// ─────────────────────────────────────────────────────────────────────────────
// MD5 — Vonigo auth requires the password as MD5 hex (their legacy auth flow).
// Web Crypto's subtle.digest doesn't support MD5 (deprecated for security), and
// Deno's std/hash/md5 module was deprecated and is unreliable to fetch. So we
// inline a small pure-JS MD5 implementation here. This is only used for the
// initial credential save — the resulting hex is stored and reused for Vonigo
// auth on every subsequent API call.
// ─────────────────────────────────────────────────────────────────────────────
function md5Hex(input: string): string {
  // RFC 1321 reference implementation, ported to TypeScript.
  // Operates on a UTF-8 encoded byte sequence.
  const bytes = new TextEncoder().encode(input);
  const len = bytes.length;
  const numBlocks = ((len + 8) >>> 6) + 1;
  const totalLen = numBlocks * 16;
  const m = new Uint32Array(totalLen);
  for (let i = 0; i < len; i++) {
    m[i >> 2] |= bytes[i] << ((i % 4) << 3);
  }
  m[len >> 2] |= 0x80 << ((len % 4) << 3);
  m[totalLen - 2] = len << 3;

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  const add32 = (x: number, y: number) => (x + y) | 0;

  const ff = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) =>
    add32(rotl(add32(add32(a, (b & c) | (~b & d)), add32(x, t)), s), b);
  const gg = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) =>
    add32(rotl(add32(add32(a, (b & d) | (c & ~d)), add32(x, t)), s), b);
  const hh = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) =>
    add32(rotl(add32(add32(a, b ^ c ^ d), add32(x, t)), s), b);
  const ii = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) =>
    add32(rotl(add32(add32(a, c ^ (b | ~d)), add32(x, t)), s), b);

  for (let i = 0; i < totalLen; i += 16) {
    const aa = a, bb = b, cc = c, dd = d;
    a = ff(a, b, c, d, m[i + 0], 7, -680876936);
    d = ff(d, a, b, c, m[i + 1], 12, -389564586);
    c = ff(c, d, a, b, m[i + 2], 17, 606105819);
    b = ff(b, c, d, a, m[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, m[i + 4], 7, -176418897);
    d = ff(d, a, b, c, m[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, m[i + 6], 17, -1473231341);
    b = ff(b, c, d, a, m[i + 7], 22, -45705983);
    a = ff(a, b, c, d, m[i + 8], 7, 1770035416);
    d = ff(d, a, b, c, m[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, m[i + 10], 17, -42063);
    b = ff(b, c, d, a, m[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, m[i + 12], 7, 1804603682);
    d = ff(d, a, b, c, m[i + 13], 12, -40341101);
    c = ff(c, d, a, b, m[i + 14], 17, -1502002290);
    b = ff(b, c, d, a, m[i + 15], 22, 1236535329);

    a = gg(a, b, c, d, m[i + 1], 5, -165796510);
    d = gg(d, a, b, c, m[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, m[i + 11], 14, 643717713);
    b = gg(b, c, d, a, m[i + 0], 20, -373897302);
    a = gg(a, b, c, d, m[i + 5], 5, -701558691);
    d = gg(d, a, b, c, m[i + 10], 9, 38016083);
    c = gg(c, d, a, b, m[i + 15], 14, -660478335);
    b = gg(b, c, d, a, m[i + 4], 20, -405537848);
    a = gg(a, b, c, d, m[i + 9], 5, 568446438);
    d = gg(d, a, b, c, m[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, m[i + 3], 14, -187363961);
    b = gg(b, c, d, a, m[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, m[i + 13], 5, -1444681467);
    d = gg(d, a, b, c, m[i + 2], 9, -51403784);
    c = gg(c, d, a, b, m[i + 7], 14, 1735328473);
    b = gg(b, c, d, a, m[i + 12], 20, -1926607734);

    a = hh(a, b, c, d, m[i + 5], 4, -378558);
    d = hh(d, a, b, c, m[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, m[i + 11], 16, 1839030562);
    b = hh(b, c, d, a, m[i + 14], 23, -35309556);
    a = hh(a, b, c, d, m[i + 1], 4, -1530992060);
    d = hh(d, a, b, c, m[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, m[i + 7], 16, -155497632);
    b = hh(b, c, d, a, m[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, m[i + 13], 4, 681279174);
    d = hh(d, a, b, c, m[i + 0], 11, -358537222);
    c = hh(c, d, a, b, m[i + 3], 16, -722521979);
    b = hh(b, c, d, a, m[i + 6], 23, 76029189);
    a = hh(a, b, c, d, m[i + 9], 4, -640364487);
    d = hh(d, a, b, c, m[i + 12], 11, -421815835);
    c = hh(c, d, a, b, m[i + 15], 16, 530742520);
    b = hh(b, c, d, a, m[i + 2], 23, -995338651);

    a = ii(a, b, c, d, m[i + 0], 6, -198630844);
    d = ii(d, a, b, c, m[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, m[i + 14], 15, -1416354905);
    b = ii(b, c, d, a, m[i + 5], 21, -57434055);
    a = ii(a, b, c, d, m[i + 12], 6, 1700485571);
    d = ii(d, a, b, c, m[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, m[i + 10], 15, -1051523);
    b = ii(b, c, d, a, m[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, m[i + 8], 6, 1873313359);
    d = ii(d, a, b, c, m[i + 15], 10, -30611744);
    c = ii(c, d, a, b, m[i + 6], 15, -1560198380);
    b = ii(b, c, d, a, m[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, m[i + 4], 6, -145523070);
    d = ii(d, a, b, c, m[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, m[i + 2], 15, 718787259);
    b = ii(b, c, d, a, m[i + 9], 21, -343485551);

    a = add32(a, aa);
    b = add32(b, bb);
    c = add32(c, cc);
    d = add32(d, dd);
  }

  // Convert to little-endian hex
  const toHex = (n: number) => {
    let s = "";
    for (let j = 0; j < 4; j++) {
      s += ((n >> (j * 8)) & 0xff).toString(16).padStart(2, "0");
    }
    return s;
  };
  return toHex(a) + toHex(b) + toHex(c) + toHex(d);
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: saveVonigoCredentials
//
// All Junkluggers franchises live under a single tenant. This function:
//   1) Authenticates to Vonigo to validate creds and discover the franchise ID
//   2) Looks up (or creates) the franchise row under the Junkluggers tenant
//   3) Attaches the user's profile to the franchise
//   4) Saves credentials via the upsert_vonigo_credential RPC (the canonical
//      write path — it handles Supabase Vault storage of the MD5)
//   5) Seeds default tools if the franchise is brand new
//
// Body: { vonigoUsername, vonigoPassword, email }
// ─────────────────────────────────────────────────────────────────────────────

// Junkluggers tenant — all Junkluggers franchises belong here. The Vonigo
// company we authenticate against ('junkluggers.vonigo.com') determines this.
// When we onboard a different brand someday, we'd look up the tenant by the
// Vonigo company instead of hardcoding.
const JUNKLUGGERS_TENANT_ID = "946a4535-aa61-45b6-a6fb-9190ff546d41";

async function supabaseRpc(name: string, args: Record<string, unknown>): Promise<Response> {
  return fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
}

async function handleSaveVonigoCredentials(body: Record<string, unknown>): Promise<Response> {
  const username = (body.vonigoUsername as string || "").trim();
  const password = (body.vonigoPassword as string || "").trim();
  const email = (body.email as string || "").trim();

  if (!username || !password || !email) {
    return jsonResponse({ success: false, error: "vonigoUsername, vonigoPassword, email required" }, 400);
  }

  const md5 = md5Hex(password);

  // 1) Authenticate to Vonigo — validates creds AND discovers the franchise
  let session: VonigoSession;
  try {
    session = await vonigoLoginAndDiscover(username, md5);
  } catch (e) {
    const err = e as Error;
    return jsonResponse({
      success: false,
      error: err.message || "Vonigo authentication failed",
    }, 401);
  }

  const discoveredExternalID = session.franchiseID;
  const discoveredFranchiseName = session.franchiseName;

  // 2) Look up the user's profile
  const profile = await lookupProfileByEmail(email);
  if (!profile) {
    return jsonResponse({
      success: false,
      error: "Profile not found for email: " + email,
    }, 404);
  }

  // 3) See if the franchise already exists under the Junkluggers tenant
  const existingFranchise = await lookupFranchiseOrNull(discoveredExternalID);

  let franchiseUUID: string;
  let franchiseCreated = false;
  let toolsSeeded = 0;

  if (existingFranchise) {
    // Franchise row exists. Check whether the user is the right owner.
    const existingOwnerEmail = await findFranchiseOwnerEmail(existingFranchise.id);

    if (existingOwnerEmail && existingOwnerEmail !== email) {
      return jsonResponse({
        success: false,
        error: "Franchise " + discoveredExternalID + " (" + discoveredFranchiseName +
               ") is already owned by another user (" + existingOwnerEmail +
               "). Please contact your CrewLogic administrator.",
      }, 409);
    }

    franchiseUUID = existingFranchise.id;

    // If the user's profile didn't yet have this franchise attached, attach it now.
    if (profile.franchise_id !== franchiseUUID) {
      const attachRes = await supabasePatch(
        `/rest/v1/profiles?id=eq.${profile.id}`,
        { franchise_id: franchiseUUID },
      );
      if (!attachRes.ok) {
        const errText = await attachRes.text().catch(() => "");
        console.error("Profile attach failed:", attachRes.status, errText);
        return jsonResponse({
          success: false,
          error: "Couldn't attach your profile to the franchise. " + errText.slice(0, 200),
        }, 500);
      }
    }
  } else {
    // 4) Franchise doesn't exist — create one under the Junkluggers tenant
    //    (NEVER create a new tenant — all Junkluggers franchises share one).
    const franchiseRes = await supabasePost("/rest/v1/franchises", {
      tenant_id: JUNKLUGGERS_TENANT_ID,
      external_id: discoveredExternalID,
      franchise_name: discoveredFranchiseName || ("Franchise " + discoveredExternalID),
      vonigo_configured: false, // becomes true after credentials are stored below
    });
    if (!franchiseRes.ok) {
      const errText = await franchiseRes.text().catch(() => "");
      console.error("Franchise create failed:", franchiseRes.status, errText);
      return jsonResponse({
        success: false,
        error: "Couldn't create franchise: " + errText.slice(0, 200),
      }, 500);
    }
    const franchiseRows = await franchiseRes.json() as Array<{ id: string }>;
    franchiseUUID = franchiseRows[0].id;
    franchiseCreated = true;

    // Attach profile to the new franchise
    const attachRes = await supabasePatch(
      `/rest/v1/profiles?id=eq.${profile.id}`,
      { franchise_id: franchiseUUID },
    );
    if (!attachRes.ok) {
      const errText = await attachRes.text().catch(() => "");
      console.error("Profile attach (new franchise) failed:", attachRes.status, errText);
      // Non-fatal — franchise exists, attach can be retried
    }

    // Seed tools from reference franchise (Junkluggers 90's 23-tool set).
    // Non-fatal if it fails — they can configure tools manually later.
    try {
      toolsSeeded = await seedToolsFromReference(JUNKLUGGERS_TENANT_ID, franchiseUUID);
    } catch (e) {
      console.warn("[seedTools] Failed but continuing:", (e as Error).message);
    }
  }

  // 5) Save credentials via the canonical RPC (handles Vault storage of the MD5)
  const credRes = await supabaseRpc("upsert_vonigo_credential", {
    p_franchise_id: franchiseUUID,
    p_username: username,
    p_md5: md5,
  });
  if (!credRes.ok) {
    const errText = await credRes.text().catch(() => "");
    console.error("upsert_vonigo_credential failed:", credRes.status, errText);
    return jsonResponse({
      success: false,
      error: `Couldn't save credentials: ${credRes.status} ${errText.slice(0, 300)}`,
    }, 500);
  }

  // 6) Mark the franchise as vonigo_configured = true
  const configRes = await supabasePatch(`/rest/v1/franchises?id=eq.${franchiseUUID}`, {
    vonigo_configured: true,
  });
  if (!configRes.ok) {
    // Non-fatal — the credential was saved successfully
    console.warn("[saveVonigoCredentials] Couldn't set vonigo_configured flag (non-fatal)");
  }

  // 7) Per-franchise trial carry (access matrix cell #4). A junkluggers prospect who came in via the
  //    marketing funnel has a trial deadline stamped on their profile AT SIGNUP. Copy it onto the
  //    franchise (so the 14-day clock — started at signup, not now — lives on their franchise even
  //    though the shared Junkluggers tenant is 'tester'), then clear the pending field. Guest-invite
  //    junkluggers have no pending value → the franchise stays 'tester' (never expires) via the tenant.
  if (profile.pending_trial_ends_at) {
    const trialRes = await supabasePatch(`/rest/v1/franchises?id=eq.${franchiseUUID}`, {
      subscription_status: "trialing",
      trial_ends_at: profile.pending_trial_ends_at,
    });
    if (trialRes.ok) {
      await supabasePatch(`/rest/v1/profiles?id=eq.${profile.id}`, { pending_trial_ends_at: null });
    } else {
      console.warn("[saveVonigoCredentials] Couldn't stamp per-franchise trial (non-fatal)");
    }
  }

  return jsonResponse({
    success: true,
    franchiseID: discoveredExternalID,
    franchiseName: discoveredFranchiseName,
    franchiseCreated,
    toolsSeeded,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: saveSettings (generic — covers franchise info, cost, proposal, signs)
// Body shape: { email, franchiseID, costSettings? (full merged object),
//               phone?, officeAddress?, officeCity?, officeState?, officeZip?, website? }
// Storage: everything goes into franchises.cost_settings JSONB. Contact fields
// (phone/website/etc) are also mirrored at the top-level keys of cost_settings
// so the existing frontend load logic (which reads costSettings.phone, etc.)
// continues to work.
// ─────────────────────────────────────────────────────────────────────────────
async function handleSaveSettings(body: Record<string, unknown>): Promise<Response> {
  const externalID = String(body.franchiseID || "");
  if (!externalID) {
    return jsonResponse({ success: false, error: "franchiseID required" }, 400);
  }

  const franchise = await lookupFranchise(externalID);
  const current = await getCurrentCostSettings(franchise.id);

  // Start from current cost_settings and apply incoming fields
  const merged: Record<string, unknown> = Object.assign({}, current);

  // If costSettings was sent (the common pattern), merge it in
  if (body.costSettings && typeof body.costSettings === "object") {
    Object.assign(merged, body.costSettings as Record<string, unknown>);
  }

  // Mirror any top-level franchise contact fields into cost_settings keys
  // (the frontend reads currentUser.costSettings.phone etc. on login)
  const contactKeys = ["phone", "officeAddress", "officeCity", "officeState", "officeZip", "website"];
  for (const key of contactKeys) {
    if (key in body) {
      merged[key] = body[key];
    }
  }

  // Build the franchise PATCH payload. Always update cost_settings; conditionally
  // update top-level franchise_name column when the caller provided one.
  const patchBody: Record<string, unknown> = { cost_settings: merged };
  if (typeof body.franchiseName === "string" && (body.franchiseName as string).trim().length > 0) {
    patchBody.franchise_name = (body.franchiseName as string).trim();
  }

  const res = await supabasePatch(`/rest/v1/franchises?id=eq.${franchise.id}`, patchBody);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("Settings save failed:", res.status, errText);
    return jsonResponse(
      { success: false, error: `DB error ${res.status}: ${errText.slice(0, 300)}` },
      500
    );
  }

  return jsonResponse({ success: true, franchiseID: externalID });
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: saveTelematics (per-franchise "Where Are My Trucks?" credential)
// Body: { franchiseInternalID, provider: 'motive'|'linxup', token }
// Per-provider: stores THIS provider's token in Vault via upsert_telematics_credential
// (does NOT wipe the other provider) and makes this provider the ACTIVE one, then
// does a live test call and stamps the result. The token is NEVER returned.
// ─────────────────────────────────────────────────────────────────────────────
async function handleSaveTelematics(body: Record<string, unknown>): Promise<Response> {
  const franchiseID = String(body.franchiseInternalID || "").trim();
  const provider = String(body.provider || "").trim().toLowerCase();
  const token = String(body.token || "").trim();

  if (!franchiseID) return jsonResponse({ success: false, error: "franchiseInternalID required" }, 400);
  if (provider !== "motive" && provider !== "linxup") {
    return jsonResponse({ success: false, error: "provider must be 'motive' or 'linxup'" }, 400);
  }
  if (!token) return jsonResponse({ success: false, error: "token required" }, 400);

  // 1) Store provider + token (token → Vault)
  const upsertRes = await supabaseRpc("upsert_telematics_credential", {
    p_franchise_id: franchiseID,
    p_provider: provider,
    p_token: token,
  });
  if (!upsertRes.ok) {
    const errText = await upsertRes.text().catch(() => "");
    console.error("upsert_telematics_credential failed:", upsertRes.status, errText);
    return jsonResponse(
      { success: false, error: `Couldn't save credential: ${upsertRes.status} ${errText.slice(0, 200)}` },
      500,
    );
  }

  // 2) Live validation call (we already hold the token in this request)
  const result = await fetchTrucks(provider, token);
  const status = result.success ? "connected" : "error";
  const truckCount = result.success ? result.trucks.length : null;
  const errMsg = result.success ? null : (result.error || "Connection failed");

  // 3) Stamp the validation result (non-fatal — the credential is already stored).
  //    Keyed by (franchise_id, provider) so it stamps THIS provider's row only.
  const stampRes = await supabaseRpc("set_telematics_status", {
    p_franchise_id: franchiseID,
    p_provider: provider,
    p_status: status,
    p_truck_count: truckCount,
    p_error: errMsg,
  });
  if (!stampRes.ok) {
    console.warn("[saveTelematics] set_telematics_status non-fatal failure:", stampRes.status);
  }

  // success = fully connected; saved = token stored regardless of validation
  return jsonResponse({
    success: result.success,
    saved: true,
    provider,
    status,
    truckCount,
    error: errMsg,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: getTelematics — per-provider non-secret status for the Settings tab.
// Body: { franchiseInternalID }
// Response (dual-provider):
//   { success, active: 'motive'|'linxup'|null,
//     providers: { motive: {configured, status, truckCount, lastError, lastValidatedAt},
//                  linxup: {..same..} } }
// A provider with no stored credential → { configured:false, ...nulls }.
// ─────────────────────────────────────────────────────────────────────────────
function emptyProviderStatus() {
  return { configured: false, status: null, truckCount: null, lastError: null, lastValidatedAt: null };
}

async function handleGetTelematics(body: Record<string, unknown>): Promise<Response> {
  const franchiseID = String(body.franchiseInternalID || "").trim();
  if (!franchiseID) return jsonResponse({ success: false, error: "franchiseInternalID required" }, 400);

  const res = await supabaseRpc("get_telematics_status", { p_franchise_id: franchiseID });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("get_telematics_status failed:", res.status, errText);
    return jsonResponse({ success: false, error: `DB error ${res.status}` }, 500);
  }
  const rows = await res.json().catch(() => []);
  const providers: Record<string, ReturnType<typeof emptyProviderStatus>> = {
    motive: emptyProviderStatus(),
    linxup: emptyProviderStatus(),
  };
  let active: string | null = null;
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const p = String(r?.provider || "").toLowerCase();
      if (p !== "motive" && p !== "linxup") continue;
      providers[p] = {
        configured: r?.configured ?? true,
        status: r?.status ?? null,
        truckCount: r?.last_truck_count ?? null,
        lastError: r?.last_error ?? null,
        lastValidatedAt: r?.last_validated_at ?? null,
      };
      if (r?.is_active) active = p;
    }
  }
  return jsonResponse({ success: true, active, providers });
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: setActiveProvider — flip which stored provider feeds the trucks map,
// WITHOUT re-entering a token. Body: { franchiseInternalID, provider }.
// ─────────────────────────────────────────────────────────────────────────────
async function handleSetActiveProvider(body: Record<string, unknown>): Promise<Response> {
  const franchiseID = String(body.franchiseInternalID || "").trim();
  const provider = String(body.provider || "").trim().toLowerCase();
  if (!franchiseID) return jsonResponse({ success: false, error: "franchiseInternalID required" }, 400);
  if (provider !== "motive" && provider !== "linxup") {
    return jsonResponse({ success: false, error: "provider must be 'motive' or 'linxup'" }, 400);
  }

  const res = await supabaseRpc("set_active_telematics_provider", {
    p_franchise_id: franchiseID,
    p_provider: provider,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("set_active_telematics_provider failed:", res.status, errText);
    return jsonResponse({ success: false, error: `DB error ${res.status}` }, 500);
  }
  const flipped = await res.json().catch(() => false); // RPC returns boolean
  if (flipped !== true) {
    return jsonResponse({ success: false, error: `${provider} is not configured for this franchise`, active: null }, 400);
  }
  return jsonResponse({ success: true, active: provider });
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: saveMotiveWebhookSecret — store the franchise's Motive geofence-webhook
// signing secret (→ Vault via upsert_motive_webhook_secret). Body: { franchiseInternalID, secret }.
// WRITE-ONLY: the secret is never returned to the client or logged.
// ─────────────────────────────────────────────────────────────────────────────
async function handleSaveMotiveWebhookSecret(body: Record<string, unknown>): Promise<Response> {
  const franchiseID = String(body.franchiseInternalID || "").trim();
  const secret = String(body.secret || "").trim();
  if (!franchiseID) return jsonResponse({ success: false, error: "franchiseInternalID required" }, 400);
  if (!secret) return jsonResponse({ success: false, error: "secret required" }, 400);

  const res = await supabaseRpc("upsert_motive_webhook_secret", {
    p_franchise_id: franchiseID,
    p_secret: secret,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("upsert_motive_webhook_secret failed:", res.status, errText.slice(0, 200));
    return jsonResponse({ success: false, error: `Couldn't save secret (${res.status})` }, 500);
  }
  return jsonResponse({ success: true, saved: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: getMotiveWebhookStatus — non-secret "configured?" for the Settings UI.
// Body: { franchiseInternalID }.
// ─────────────────────────────────────────────────────────────────────────────
async function handleGetMotiveWebhookStatus(body: Record<string, unknown>): Promise<Response> {
  const franchiseID = String(body.franchiseInternalID || "").trim();
  if (!franchiseID) return jsonResponse({ success: false, error: "franchiseInternalID required" }, 400);
  const res = await supabaseRpc("get_motive_webhook_status", { p_franchise_id: franchiseID });
  if (!res.ok) return jsonResponse({ success: false, error: `DB error ${res.status}` }, 500);
  const rows = await res.json().catch(() => []);
  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  return jsonResponse({ success: true, configured: !!row, updatedAt: row?.updated_at || null });
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: saveLinxupWebhookSecret — GENERATE a random receiver token server-side,
// store it in Vault (upsert_linxup_webhook_secret), and return it ONCE for the
// Owner to paste into Linxup's webhook config. Re-calling ROTATES the token.
// Body: { franchiseInternalID }. The token is returned exactly once, never logged.
// The crewlogic-linxup-webhook receiver checks the incoming Bearer against it.
// ─────────────────────────────────────────────────────────────────────────────
function generateWebhookToken(): string {
  // ~32 bytes of CSPRNG entropy → URL-safe base64 (no +,/,= so it's paste-safe).
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function handleSaveLinxupWebhookSecret(body: Record<string, unknown>): Promise<Response> {
  const franchiseID = String(body.franchiseInternalID || "").trim();
  if (!franchiseID) return jsonResponse({ success: false, error: "franchiseInternalID required" }, 400);

  const token = generateWebhookToken();
  const res = await supabaseRpc("upsert_linxup_webhook_secret", {
    p_franchise_id: franchiseID,
    p_secret: token,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("upsert_linxup_webhook_secret failed:", res.status, errText.slice(0, 200));
    return jsonResponse({ success: false, error: `Couldn't save token (${res.status})` }, 500);
  }
  // Return the generated token ONCE — this is the only time it leaves the server.
  return jsonResponse({ success: true, token });
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: getLinxupWebhookStatus — non-secret "configured?" for the Settings UI.
// Body: { franchiseInternalID }.
// ─────────────────────────────────────────────────────────────────────────────
async function handleGetLinxupWebhookStatus(body: Record<string, unknown>): Promise<Response> {
  const franchiseID = String(body.franchiseInternalID || "").trim();
  if (!franchiseID) return jsonResponse({ success: false, error: "franchiseInternalID required" }, 400);
  const res = await supabaseRpc("get_linxup_webhook_status", { p_franchise_id: franchiseID });
  if (!res.ok) return jsonResponse({ success: false, error: `DB error ${res.status}` }, 500);
  const rows = await res.json().catch(() => []);
  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  return jsonResponse({ success: true, configured: !!row, updatedAt: row?.updated_at || null });
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: saveHomeCardOrder (per-user home-screen drag-to-reorder preference)
// Body: { order: string[] }  — the card keys in the user's chosen order.
// Auth: the caller is identified from the Authorization Bearer token (their own
// Supabase Auth session). We update ONLY that user's own profile row (matched by
// auth_user_id) and ONLY the home_card_order column — never another user/column.
// ─────────────────────────────────────────────────────────────────────────────
async function handleSaveHomeCardOrder(
  body: Record<string, unknown>,
  token: string | null,
): Promise<Response> {
  // 1) Verify the caller from their Bearer token (mirrors crewlogic-admin)
  if (!token) {
    return jsonResponse({ success: false, error: "Missing Authorization token" }, 401);
  }
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: { user }, error: authErr } = await anonClient.auth.getUser(token);
  if (authErr || !user) {
    return jsonResponse({ success: false, error: "Invalid or expired session" }, 401);
  }

  // 2) Validate the order payload — array of short strings only
  const order = body.order;
  if (!Array.isArray(order) || order.length > 20) {
    return jsonResponse({ success: false, error: "order must be an array of <=20 strings" }, 400);
  }
  for (const item of order) {
    if (typeof item !== "string" || item.length === 0 || item.length > 40) {
      return jsonResponse({ success: false, error: "each order item must be a short string" }, 400);
    }
  }

  // 3) Update ONLY the caller's own profile row, ONLY the home_card_order column
  const res = await supabasePatch(
    `/rest/v1/profiles?auth_user_id=eq.${encodeURIComponent(user.id)}`,
    { home_card_order: order },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("saveHomeCardOrder update failed:", res.status, errText);
    return jsonResponse({ success: false, error: `DB error ${res.status}` }, 500);
  }

  return jsonResponse({ success: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: saveSmsTemplate (per-user text-message pre-fill template)
// Body: { template: string } — the user's SMS template (with {{customer name}} etc.).
// Auth: caller identified from the Bearer token; updates ONLY that user's own profile
// row (auth_user_id) and ONLY the sms_template column. Mirrors saveHomeCardOrder.
// ─────────────────────────────────────────────────────────────────────────────
async function handleSaveSmsTemplate(
  body: Record<string, unknown>,
  token: string | null,
): Promise<Response> {
  if (!token) {
    return jsonResponse({ success: false, error: "Missing Authorization token" }, 401);
  }
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: { user }, error: authErr } = await anonClient.auth.getUser(token);
  if (authErr || !user) {
    return jsonResponse({ success: false, error: "Invalid or expired session" }, 401);
  }
  const template = body.template;
  if (typeof template !== "string" || template.length > 1000) {
    return jsonResponse({ success: false, error: "template must be a string <=1000 chars" }, 400);
  }
  const res = await supabasePatch(
    `/rest/v1/profiles?auth_user_id=eq.${encodeURIComponent(user.id)}`,
    { sms_template: template },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("saveSmsTemplate update failed:", res.status, errText);
    return jsonResponse({ success: false, error: `DB error ${res.status}` }, 500);
  }
  return jsonResponse({ success: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// FACILITIES (disposal/recycling/donation sites + hours + holidays)
//
// These live in the relational tables `facilities`, `facility_hours`, and
// `franchise_holidays` (migration 0023) — moved out of the cost_settings JSONB
// blob. All three tables are RLS service-role-only, so the client reaches them
// only through these edge-fn actions.
//
// Resolution of the caller's franchise: when a real Supabase Auth Bearer token is
// present (native/Google/dev-password sessions), we verify the caller via
// auth.getUser(token) → their profile → franchise_id. When no user session is
// present (anon-key fallback), we resolve by the external franchiseID in the body
// — the SAME trust model saveCostSettings already uses (facilities were written
// through saveCostSettings before this repoint), so this preserves current behavior.
// ─────────────────────────────────────────────────────────────────────────────
const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]; // index = dow (0=Sun..6=Sat)

function trimTime(t: string | null | undefined): string {
  return t ? String(t).slice(0, 5) : ""; // "HH:MM:SS" → "HH:MM"
}

function toNum(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Default seed hours per dow: Mon–Fri 07:00–16:00, Sat 07:00–12:00, Sun closed.
function defaultHours(dow: number): { is_closed: boolean; open_time: string | null; close_time: string | null } {
  if (dow === 0) return { is_closed: true, open_time: null, close_time: null };
  if (dow === 6) return { is_closed: false, open_time: "07:00", close_time: "12:00" };
  return { is_closed: false, open_time: "07:00", close_time: "16:00" };
}

async function resolveFranchiseForCaller(
  body: Record<string, unknown>,
  token: string | null,
): Promise<{ id: string }> {
  // Prefer caller verification when a real user token (not the anon key) is present.
  if (token && token !== ANON_KEY) {
    try {
      const anonClient = createClient(SUPABASE_URL, ANON_KEY);
      const { data: { user }, error } = await anonClient.auth.getUser(token);
      if (!error && user) {
        const rows = (await supabaseGet(
          `/rest/v1/profiles?auth_user_id=eq.${encodeURIComponent(user.id)}&select=franchise_id`,
        )) as Array<{ franchise_id: string | null }>;
        const fid = rows && rows[0] && rows[0].franchise_id;
        if (fid) return { id: fid };
      }
    } catch (e) {
      console.warn("[facilities] token resolution failed, falling back to franchiseID:", (e as Error).message);
    }
  }
  // Fallback: resolve by external franchiseID (same as saveCostSettings).
  const externalID = String(body.franchiseID || "");
  if (!externalID) throw new Error("Could not resolve caller franchise (no session and no franchiseID)");
  const f = await lookupFranchise(externalID);
  return { id: f.id };
}

// HANDLER: getFacilities — returns sites + hours + holidays in the UI's in-memory shape.
async function handleGetFacilities(
  body: Record<string, unknown>,
  token: string | null,
): Promise<Response> {
  const { id: franchiseUUID } = await resolveFranchiseForCaller(body, token);

  // provider/provider_geofence_id MUST be selected here and echoed back by saveFacilities.
  // saveFacilities is a replace-set (delete-all + insert), so anything absent from this
  // round-trip is destroyed on the next save — which would silently unlink every facility
  // from its telematics geofence the first time an owner edited an unrelated field.
  const facs = (await supabaseGet(
    `/rest/v1/facilities?franchise_id=eq.${franchiseUUID}` +
      `&select=id,type,name,address,per_ton_rate,minimum_type,minimum_value,is_default,sort_order,provider,provider_geofence_id` +
      `&order=type.asc,sort_order.asc`,
  )) as Array<Record<string, unknown>>;

  // Join facility_hours → per-facility { mon..sun: {open,close,closed} }
  const hoursByFac: Record<string, Record<string, { open: string; close: string; closed: boolean }>> = {};
  if (facs.length) {
    const ids = facs.map((f) => f.id as string);
    const hrs = (await supabaseGet(
      `/rest/v1/facility_hours?facility_id=in.(${ids.join(",")})` +
        `&select=facility_id,dow,is_closed,open_time,close_time`,
    )) as Array<Record<string, unknown>>;
    for (const h of hrs) {
      const fid = h.facility_id as string;
      if (!hoursByFac[fid]) hoursByFac[fid] = {};
      const key = DOW_KEYS[h.dow as number];
      if (!key) continue;
      const closed = !!h.is_closed;
      hoursByFac[fid][key] = {
        open: closed ? "" : trimTime(h.open_time as string | null),
        close: closed ? "" : trimTime(h.close_time as string | null),
        closed,
      };
    }
  }

  const toSite = (f: Record<string, unknown>) => {
    const site: Record<string, unknown> = {
      name: f.name || "",
      address: f.address || "",
      isDefault: !!f.is_default,
      minimumType: (f.minimum_type as string) || "none",
      minimumValue: toNum(f.minimum_value),
      hours: hoursByFac[f.id as string] || {},
      // Telematics link — the stable facility identity (see contract-recycling-revenue D1).
      provider: (f.provider as string) || "",
      geofenceId: f.provider_geofence_id != null ? String(f.provider_geofence_id) : "",
    };
    if (f.type === "disposal") site.cost = toNum(f.per_ton_rate);
    else if (f.type === "recycling") site.revenue = toNum(f.per_ton_rate);
    return site;
  };

  const disposalSites = facs.filter((f) => f.type === "disposal").map(toSite);
  const recyclingSites = facs.filter((f) => f.type === "recycling").map(toSite);
  const donationSites = facs.filter((f) => f.type === "donation").map(toSite);

  // Holidays → { federal:{key:bool}, custom:[{name,date}] }
  const hols = (await supabaseGet(
    `/rest/v1/franchise_holidays?franchise_id=eq.${franchiseUUID}` +
      `&select=federal_key,custom_label,custom_date,is_observed`,
  )) as Array<Record<string, unknown>>;
  const federal: Record<string, boolean> = {};
  const custom: Array<{ name: string; date: string }> = [];
  for (const h of hols) {
    if (h.federal_key) {
      federal[h.federal_key as string] = h.is_observed !== false;
    } else if (h.custom_label != null || h.custom_date != null) {
      custom.push({ name: (h.custom_label as string) || "", date: (h.custom_date as string) || "" });
    }
  }

  return jsonResponse({
    success: true,
    disposalSites,
    recyclingSites,
    donationSites,
    disposalHolidays: { federal, custom },
  });
}

// HANDLER: listGeofences — the franchise's own telematics geofences, for the facility picker.
//
// Reads the per-franchise cache the webhook already maintains (motive_geofences, populated by
// crewlogic-motive-webhook's resolveGeofenceName from GET /v1/geofences). No Motive call here:
// the picker must work instantly and offline-ish, and a franchise that has received any webhook
// already has its geofences cached.
//
// Generic by design (contract D7): every franchise picks from ITS OWN geofences. No franchise's
// ids are hardcoded anywhere — #90 is simply the first user of this mechanism.
async function handleListGeofences(
  body: Record<string, unknown>,
  token: string | null,
): Promise<Response> {
  const { id: franchiseUUID } = await resolveFranchiseForCaller(body, token);

  const rows = (await supabaseGet(
    `/rest/v1/motive_geofences?franchise_id=eq.${franchiseUUID}` +
      `&select=geofence_id,name,category&order=name.asc`,
  )) as Array<Record<string, unknown>>;

  return jsonResponse({
    success: true,
    provider: "motive",
    geofences: rows.map((g) => ({
      id: String(g.geofence_id),
      name: (g.name as string) || `Geofence ${g.geofence_id}`,
      category: (g.category as string) || "",
    })),
  });
}

// HANDLER: saveFacilities — replace-set the franchise's facilities/hours/holidays.
// Accepts the same shape getFacilities returns.
async function handleSaveFacilities(
  body: Record<string, unknown>,
  token: string | null,
): Promise<Response> {
  const { id: franchiseUUID } = await resolveFranchiseForCaller(body, token);

  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
  const disposalSites = arr(body.disposalSites);
  const recyclingSites = arr(body.recyclingSites);
  const donationSites = arr(body.donationSites);
  const holidays = (body.disposalHolidays && typeof body.disposalHolidays === "object")
    ? (body.disposalHolidays as Record<string, unknown>)
    : { federal: {}, custom: [] };

  // 1) Build facility rows (+ parallel hours sources, same index order).
  const types: Array<[string, any[]]> = [
    ["disposal", disposalSites],
    ["recycling", recyclingSites],
    ["donation", donationSites],
  ];
  const facRows: Array<Record<string, unknown>> = [];
  const hoursSrc: Array<Record<string, unknown> | null> = [];
  for (const [type, sites] of types) {
    sites.forEach((s: Record<string, unknown>, idx: number) => {
      // Round-trip the telematics link. A blank geofenceId stores NULL (unlinked), never 0 —
      // 0 would collide in the unique index and read as a real geofence.
      const gidRaw = String((s && (s as Record<string, unknown>).geofenceId) ?? "").trim();
      const gid = /^\d+$/.test(gidRaw) ? Number(gidRaw) : null;
      const prov = String((s && (s as Record<string, unknown>).provider) ?? "").trim().toLowerCase();
      facRows.push({
        franchise_id: franchiseUUID,
        type,
        name: (s && s.name) || "",
        address: (s && s.address) || "",
        per_ton_rate: type === "disposal" ? toNum(s && s.cost) : type === "recycling" ? toNum(s && s.revenue) : null,
        minimum_type: (s && (s.minimumType as string)) || "none",
        minimum_value: toNum(s && s.minimumValue),
        is_default: !!(s && s.isDefault),
        sort_order: idx,
        provider: gid != null ? (prov === "linxup" ? "linxup" : "motive") : null,
        provider_geofence_id: gid,
      });
      hoursSrc.push((s && s.hours && typeof s.hours === "object") ? (s.hours as Record<string, unknown>) : null);
    });
  }

  // 2) Replace-set facilities: delete existing (cascades facility_hours), then insert.
  const delFac = await supabaseDelete(`/rest/v1/facilities?franchise_id=eq.${franchiseUUID}`);
  if (!delFac.ok) {
    const t = await delFac.text().catch(() => "");
    console.error("[saveFacilities] delete facilities failed:", delFac.status, t);
    return jsonResponse({ success: false, error: `Couldn't clear facilities: ${delFac.status}` }, 500);
  }

  if (facRows.length) {
    const insFac = await supabasePost("/rest/v1/facilities", facRows);
    if (!insFac.ok) {
      const t = await insFac.text().catch(() => "");
      console.error("[saveFacilities] insert facilities failed:", insFac.status, t);
      return jsonResponse({ success: false, error: `Couldn't save facilities: ${insFac.status} ${t.slice(0, 200)}` }, 500);
    }
    const facCreated = (await insFac.json()) as Array<{ id: string }>;

    // 3) Build + insert facility_hours (7 rows per facility; default-seed missing days).
    const hoursRows: Array<Record<string, unknown>> = [];
    facCreated.forEach((fac, k) => {
      const h = hoursSrc[k];
      for (let dow = 0; dow < 7; dow++) {
        const day = h ? (h[DOW_KEYS[dow]] as Record<string, unknown> | undefined) : undefined;
        if (day && typeof day === "object") {
          const closed = !!day.closed;
          hoursRows.push({
            facility_id: fac.id,
            dow,
            is_closed: closed,
            open_time: closed ? null : ((day.open as string) || null),
            close_time: closed ? null : ((day.close as string) || null),
          });
        } else {
          hoursRows.push({ facility_id: fac.id, dow, ...defaultHours(dow) });
        }
      }
    });
    if (hoursRows.length) {
      const insHrs = await supabasePost("/rest/v1/facility_hours", hoursRows);
      if (!insHrs.ok) {
        const t = await insHrs.text().catch(() => "");
        console.error("[saveFacilities] insert facility_hours failed:", insHrs.status, t);
        return jsonResponse({ success: false, error: `Couldn't save facility hours: ${insHrs.status} ${t.slice(0, 200)}` }, 500);
      }
    }
  }

  // 4) Replace-set holidays.
  const delHol = await supabaseDelete(`/rest/v1/franchise_holidays?franchise_id=eq.${franchiseUUID}`);
  if (!delHol.ok) {
    const t = await delHol.text().catch(() => "");
    console.error("[saveFacilities] delete holidays failed:", delHol.status, t);
    return jsonResponse({ success: false, error: `Couldn't clear holidays: ${delHol.status}` }, 500);
  }
  const holRows: Array<Record<string, unknown>> = [];
  const fed = (holidays.federal && typeof holidays.federal === "object") ? (holidays.federal as Record<string, unknown>) : {};
  for (const k of Object.keys(fed)) {
    holRows.push({ franchise_id: franchiseUUID, federal_key: k, is_observed: !!fed[k] });
  }
  const cust = Array.isArray(holidays.custom) ? (holidays.custom as Array<Record<string, unknown>>) : [];
  for (const c of cust) {
    if (c && (c.name || c.date)) {
      holRows.push({
        franchise_id: franchiseUUID,
        custom_label: (c.name as string) || null,
        custom_date: (c.date as string) || null,
      });
    }
  }
  if (holRows.length) {
    const insHol = await supabasePost("/rest/v1/franchise_holidays", holRows);
    if (!insHol.ok) {
      const t = await insHol.text().catch(() => "");
      console.error("[saveFacilities] insert holidays failed:", insHol.status, t);
      return jsonResponse({ success: false, error: `Couldn't save holidays: ${insHol.status} ${t.slice(0, 200)}` }, 500);
    }
  }

  return jsonResponse({
    success: true,
    franchiseID: body.franchiseID || null,
    counts: { facilities: facRows.length, holidays: holRows.length },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing
// ─────────────────────────────────────────────────────────────────────────────
const ACTION_HANDLERS: Record<string, (body: Record<string, unknown>) => Promise<Response>> = {
  saveVonigoCredentials: handleSaveVonigoCredentials,
  saveTelematics:        handleSaveTelematics,
  getTelematics:         handleGetTelematics,
  setActiveProvider:     handleSetActiveProvider,
  saveMotiveWebhookSecret: handleSaveMotiveWebhookSecret,
  getMotiveWebhookStatus:  handleGetMotiveWebhookStatus,
  saveLinxupWebhookSecret: handleSaveLinxupWebhookSecret,
  getLinxupWebhookStatus:  handleGetLinxupWebhookStatus,
  // The 4 other settings save flows all just write to cost_settings JSONB and/or
  // top-level columns — handled by one generic handler.
  saveFranchiseInfo:     handleSaveSettings,
  saveCostSettings:      handleSaveSettings,
  saveProposalSettings:  handleSaveSettings,
  saveSignsConfig:       handleSaveSettings,
  saveSettings:          handleSaveSettings,
};

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
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

  // Determine action — explicit if provided, else infer from payload shape:
  //   - vonigoPassword in body → saveVonigoCredentials
  //   - anything else → saveSettings (generic merge)
  let action = (body.action as string | undefined);
  if (!action) {
    if (body.vonigoPassword) action = "saveVonigoCredentials";
    else action = "saveSettings";
  }

  // Token-aware actions (caller-verified via the Authorization Bearer token) are
  // routed here rather than through the body-only ACTION_HANDLERS map.
  if (action === "saveHomeCardOrder" || action === "saveSmsTemplate" || action === "getFacilities" || action === "saveFacilities" || action === "listGeofences") {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : null;
    try {
      if (action === "saveHomeCardOrder") return await handleSaveHomeCardOrder(body, token);
      if (action === "saveSmsTemplate") return await handleSaveSmsTemplate(body, token);
      if (action === "getFacilities") return await handleGetFacilities(body, token);
      if (action === "listGeofences") return await handleListGeofences(body, token);
      return await handleSaveFacilities(body, token);
    } catch (e) {
      const err = e as Error;
      console.error(`crewlogic-settings ${action} error:`, err);
      return jsonResponse({ success: false, error: err.message || "Internal error" }, 500);
    }
  }

  const handler = ACTION_HANDLERS[action];
  if (!handler) {
    return jsonResponse({ success: false, error: `Unknown action: ${action}` }, 400);
  }

  try {
    return await handler(body);
  } catch (e) {
    const err = e as Error;
    console.error("crewlogic-settings error:", err);
    return jsonResponse({ success: false, error: err.message || "Internal error" }, 500);
  }
});
