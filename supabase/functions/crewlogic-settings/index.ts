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
//
// SECRETS REQUIRED (auto-populated by Supabase):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { fetchTrucks } from "../_shared/telematics.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

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
// Stores the token in Vault via upsert_telematics_credential, then does a live
// test call to the provider and stamps the result. The token is NEVER returned.
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

  // 3) Stamp the validation result (non-fatal — the credential is already stored)
  const stampRes = await supabaseRpc("set_telematics_status", {
    p_franchise_id: franchiseID,
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
// HANDLER: getTelematics — non-secret status for the Settings tab (NO token)
// Body: { franchiseInternalID }
// ─────────────────────────────────────────────────────────────────────────────
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
  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  return jsonResponse({
    success: true,
    configured: !!row,
    provider: row?.provider || null,
    status: row?.status || null,
    truckCount: row?.last_truck_count ?? null,
    lastValidatedAt: row?.last_validated_at || null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing
// ─────────────────────────────────────────────────────────────────────────────
const ACTION_HANDLERS: Record<string, (body: Record<string, unknown>) => Promise<Response>> = {
  saveVonigoCredentials: handleSaveVonigoCredentials,
  saveTelematics:        handleSaveTelematics,
  getTelematics:         handleGetTelematics,
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
