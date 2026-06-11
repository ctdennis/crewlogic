// crewlogic-oauth-callback
//
// Replaces the n8n workflow `crewlogic-oauth-callback`. Handles the Google OAuth
// redirect flow end-to-end:
//
//   1. Exchange the auth code with Google for tokens (access_token, id_token)
//   2. Use Google's id_token to sign into Supabase Auth (creates auth.users on first
//      sign-in, returns access_token for the user)
//   3. Fetch the user's profile from /rest/v1/profiles (joined to franchises + tenants)
//   4. Three branches:
//        a. Profile exists → build session, redirect with ?session=...
//        b. No profile + invite token in OAuth state → provision profile from invite
//        c. No profile + no invite → redirect with ?auth_error=no_account
//   5. Return a 302 redirect to crewlogicai.com with the session (or error) in the URL
//
// Frontend reads ?session=... or ?auth_error=... on init and proceeds accordingly.

// deno-lint-ignore-file no-explicit-any

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createNativeTenantAndFranchise } from "../_shared/provisionNative.ts";

// Set as Edge Function secrets (not committed):
//   supabase secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") || "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";

// Environment-derived so the SAME file is correct on dev and prod. SUPABASE_URL and
// SUPABASE_ANON_KEY are auto-injected by Supabase into every Edge Function (→ point at whichever
// project this is deployed to). APP_BASE is the site we redirect back to — set the APP_BASE secret
// on dev (= https://dev.crewlogic.pages.dev); prod has no secret and falls back to crewlogicai.com.
// Fallbacks keep prod byte-identical to the previous hardcoded behavior.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://ozfkpxyachigfpcmvekz.supabase.co";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im96ZmtweHlhY2hpZ2ZwY212ZWt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0MjM0ODcsImV4cCI6MjA5MDk5OTQ4N30.tRwucg1ndO8l0h4vhvBpUFG7UONeqqFPE-iktH8fYX8";
// Service role — auto-injected into every Edge Function. Provisioning here (profile/invite reads
// + writes) is trusted server-side work and MUST bypass RLS; the anon key below subjected the
// profile INSERT to the Phase-3 RLS cutover and broke it (profile_create_failed → "Something went
// wrong" on invite/signup via the custom Google callback). No hardcoded fallback — never commit it.
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const APP_BASE = Deno.env.get("APP_BASE") || "https://crewlogicai.com";

// This is the URL Google redirects to. MUST match (a) what the frontend sends as
// `redirect_uri` when initiating OAuth and (b) what's listed in Google Cloud Console
// → APIs & Services → Credentials → OAuth 2.0 Client IDs → Authorized redirect URIs.
const OAUTH_REDIRECT_URI = `${SUPABASE_URL}/functions/v1/crewlogic-oauth-callback`;

// Service-role headers for all PostgREST calls in this callback (profile lookup, provisioning
// insert, invite mark). Service role so RLS is bypassed — see SUPABASE_SERVICE_ROLE_KEY note above.
// (signIntoSupabase still uses the anon key against the auth endpoint, which is correct.)
const SB_HEADERS = {
  "apikey": SUPABASE_SERVICE_ROLE_KEY,
  "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {
  // Edge Functions get invoked at /functions/v1/crewlogic-oauth-callback.
  // We only handle GET (Google's redirect) — anything else returns 405.
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";

  if (!code) {
    return redirectError("missing_code", "");
  }

  try {
    // 1. Exchange the auth code for Google tokens
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.id_token) {
      console.error("Google token exchange returned no id_token", tokens);
      return redirectError("token_exchange_failed", "");
    }

    // 2. Sign into Supabase using the Google id_token. This creates auth.users on
    //    first sign-in, returns existing user otherwise.
    const supabaseAuth = await signIntoSupabase(tokens.id_token);
    const authUserId = supabaseAuth?.user?.id || null;

    // 3. Get the Google user's profile info (name, email, picture)
    const userInfo = await fetchGoogleUserInfo(tokens.access_token);
    if (!userInfo?.email) {
      console.error("Google userinfo returned no email");
      return redirectError("userinfo_failed", "");
    }

    // 4. Look up the user's profile in our DB
    const profile = await lookupProfile(userInfo.email);

    // OAuth state carries the invite, two shapes (back-compat):
    //   "invite:<token>"           team-member / existing-franchise invite (no company name)
    //   "inviteN:<base64url-json>" new native workspace — payload {t:token, c:companyName}.
    // The company name can only reach this server-side callback via state (the browser's
    // localStorage isn't readable here), so the new-native Google flow rides it in.
    let inviteToken: string | null = null;
    let inviteCompany: string | null = null;
    let inviteName: string | null = null;
    // Self-serve native signup (no invite). "signupN:" + base64url{c:company, n:name}. The
    // company name can only reach this server-side callback via state, same as inviteN.
    let isSignup = false;
    let signupCompany: string | null = null;
    let signupName: string | null = null;
    if (state.startsWith("invite:")) {
      inviteToken = state.slice(7);
    } else if (state.startsWith("inviteN:")) {
      try {
        const payload = JSON.parse(b64urlDecode(state.slice(8)));
        inviteToken = (payload && payload.t) ? String(payload.t) : null;
        inviteCompany = (payload && payload.c) ? String(payload.c).trim() : null;
        inviteName = (payload && payload.n) ? String(payload.n).trim() : null;
      } catch (e) {
        console.error("inviteN state decode failed:", e);
      }
    } else if (state.startsWith("signupN:")) {
      try {
        const payload = JSON.parse(b64urlDecode(state.slice(8)));
        isSignup = true;
        signupCompany = (payload && payload.c) ? String(payload.c).trim() : null;
        signupName = (payload && payload.n) ? String(payload.n).trim() : null;
      } catch (e) {
        console.error("signupN state decode failed:", e);
      }
    }

    // 5. Branch on profile state
    let resolvedProfile = profile;

    if (!resolvedProfile && inviteToken) {
      // Provision new profile from invite
      const provResult = await provisionFromInvite({
        inviteToken,
        email: userInfo.email,
        // Prefer the name the owner typed on the invite screen (carried in state); fall back to
        // the Google account name only if they left it blank.
        name: inviteName || userInfo.name || null,
        authUserId,
        companyName: inviteCompany,
      });
      if (provResult.error) {
        return redirectError(provResult.error, userInfo.email);
      }
      resolvedProfile = provResult.profile;
    } else if (!resolvedProfile && isSignup) {
      // No profile + self-serve signup intent → provision a brand-new native workspace.
      const provResult = await provisionFromSignup({
        email: userInfo.email,
        name: signupName || userInfo.name || null,
        authUserId,
        companyName: signupCompany,
      });
      if (provResult.error) {
        return redirectError(provResult.error, userInfo.email);
      }
      resolvedProfile = provResult.profile;
    }

    if (!resolvedProfile) {
      // No profile, no invite, no signup → friendly error
      return redirectError("no_account", userInfo.email);
    }

    // 6. Build session and redirect
    const session = buildSession({
      profile: resolvedProfile,
      userInfo,
      googleAccessToken: tokens.access_token,
      supabaseAccessToken: supabaseAuth?.access_token || null,
      inviteToken,
    });

    return redirectSession(session);

  } catch (err) {
    console.error("OAuth callback error:", err);
    return redirectError("server_error", "");
  }
});

// Decode a URL-safe base64 (no padding) UTF-8 string. Mirrors the client encoder in
// triggerGoogleSignIn (btoa(unescape(encodeURIComponent(json))) → +/=→-_ stripped).
function b64urlDecode(s: string): string {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return decodeURIComponent(escape(atob(b64)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Exchange Google auth code for tokens
// ─────────────────────────────────────────────────────────────────────────────
async function exchangeCodeForTokens(code: string): Promise<any> {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: OAUTH_REDIRECT_URI,
    grant_type: "authorization_code",
    code,
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Google token exchange failed: ${res.status} ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Sign into Supabase using Google id_token
// ─────────────────────────────────────────────────────────────────────────────
async function signIntoSupabase(idToken: string): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=id_token`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider: "google",
      id_token: idToken,
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.warn(`Supabase sign-in failed: ${res.status} ${txt.slice(0, 300)}`);
    // Non-fatal — we can still proceed without a Supabase session token.
    // The user just won't have RLS-enforced access to Supabase directly.
    return null;
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Get Google user info
// ─────────────────────────────────────────────────────────────────────────────
async function fetchGoogleUserInfo(accessToken: string): Promise<any> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Google userinfo failed: ${res.status} ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: Look up profile by email (joined with franchise + tenant)
// ─────────────────────────────────────────────────────────────────────────────
async function lookupProfile(email: string): Promise<any> {
  const select = "role,franchise_id,email,name,pending_trial_ends_at,franchises(external_id,franchise_name,cost_settings,subscription_tier,subscription_status,trial_ends_at,vonigo_configured,tenants(id,subscription_status,trial_ends_at,pricing_source,customer_source,submission_target))";
  const url = `${SUPABASE_URL}/rest/v1/profiles?select=${encodeURIComponent(select)}&email=eq.${encodeURIComponent(email)}`;
  const res = await fetch(url, { headers: SB_HEADERS });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Profile lookup failed: ${res.status} ${txt.slice(0, 300)}`);
  }
  const arr = await res.json();
  return Array.isArray(arr) && arr[0] ? arr[0] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5b: Provision a new profile from an invite token
// ─────────────────────────────────────────────────────────────────────────────
async function provisionFromInvite(opts: {
  inviteToken: string;
  email: string;
  name: string | null;
  authUserId: string | null;
  companyName: string | null;
}): Promise<{ profile?: any; error?: string }> {

  // Look up the invite
  const inviteUrl = `${SUPABASE_URL}/rest/v1/invites?select=id,franchise_id,role,email,expires_at,accepted_at&token=eq.${encodeURIComponent(opts.inviteToken)}`;
  let invite: any;
  try {
    const res = await fetch(inviteUrl, { headers: SB_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    invite = arr && arr[0];
  } catch (e) {
    console.error("Invite lookup failed:", e);
    return { error: "invite_lookup_failed" };
  }

  if (!invite) return { error: "invite_invalid" };
  if (invite.accepted_at) return { error: "invite_already_used" };
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return { error: "invite_expired" };
  }
  // An invite addressed to a specific email may only be redeemed by that email (a leaked token
  // can't be claimed by a different Google account). Empty invite.email = open invite. Parity with
  // the email/magic-link path (crewlogic-accept-invite).
  if (invite.email && String(invite.email).toLowerCase() !== opts.email.toLowerCase()) {
    return { error: "invite_email_mismatch" };
  }

  // Resolve the franchise (provisioning & access matrix, docs/provisioning-access-matrix-spec.md).
  // Existing-franchise invite (team member) → use it. Guest invite (no franchise_id) branches on the
  // accepter's EMAIL DOMAIN:
  //   - @junkluggers.com → leave franchise_id NULL (Vonigo-pending); NO native tenant. They connect
  //     Vonigo creds in Settings, which attaches their real franchise under the shared Junkluggers
  //     tenant (saveVonigoCredentials). Null-franchise profile gets access via the client's 'trialing'
  //     fallback (no clock → never expires), then 'tester' once attached.
  //   - any other domain → create a NEW native workspace (non-expiring 'tester', no trial clock).
  // Mirrors crewlogic-accept-invite. Only direct signups (provisionFromSignup) get the 14-day trial.
  const isJunkluggers = /@junkluggers\.com$/i.test(opts.email || "");
  let franchiseId: string | null = invite.franchise_id || null;
  let role: string = invite.role || "estimator";
  if (!franchiseId) {
    role = invite.role || "owner";
    if (!isJunkluggers) {
      try {
        const sbAdmin = createClient(
          Deno.env.get("SUPABASE_URL") || SUPABASE_URL,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
        );
        const r = await createNativeTenantAndFranchise(sbAdmin, opts.companyName || "", { subscriptionStatus: "tester", setTrialClock: false });
        franchiseId = r.franchiseId;
      } catch (e) {
        console.error("Native provision failed:", e);
        return { error: "native_provision_failed" };
      }
    }
  }

  // Insert the profile. on_conflict=email handles the rare race condition where
  // two concurrent OAuth flows for the same email both try to provision.
  const profileId = crypto.randomUUID();
  let inserted: any;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?on_conflict=email`,
      {
        method: "POST",
        headers: {
          ...SB_HEADERS,
          "Prefer": "return=representation,resolution=merge-duplicates",
        },
        body: JSON.stringify({
          id: profileId,
          auth_user_id: opts.authUserId,
          email: opts.email,
          name: opts.name,
          role,
          franchise_id: franchiseId,
        }),
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }
    const arr = await res.json();
    inserted = Array.isArray(arr) ? arr[0] : arr;
  } catch (e) {
    console.error("Profile insert failed:", e);
    return { error: "profile_create_failed" };
  }

  if (!inserted) return { error: "profile_create_failed" };

  // Mark invite accepted (best-effort — failure is non-fatal, just logged)
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/invites?id=eq.${encodeURIComponent(invite.id)}`,
      {
        method: "PATCH",
        headers: SB_HEADERS,
        body: JSON.stringify({ accepted_at: new Date().toISOString() }),
      }
    );
  } catch (e) {
    console.warn("Mark invite accepted failed (non-fatal):", e);
  }

  // Re-fetch the profile with franchise/tenant joins so buildSession has the
  // same shape it expects from a normal lookup.
  const hydrated = await lookupProfile(opts.email);
  return { profile: hydrated || inserted };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5c: Provision a brand-new native workspace + owner profile WITHOUT an invite
// (self-serve signup). Mirrors provisionFromInvite's native branch + profile insert, minus
// the invite lookup/accept. The owner is role=owner. Parity with crewlogic-signup (email path).
// ─────────────────────────────────────────────────────────────────────────────
async function provisionFromSignup(opts: {
  email: string;
  name: string | null;
  authUserId: string | null;
  companyName: string | null;
}): Promise<{ profile?: any; error?: string }> {

  // Create tenant+franchise via the shared helper (service role — RLS blocks anon inserts on
  // tenants/franchises). Fall back to the email domain if no company name came through.
  let franchiseId: string;
  try {
    const sbAdmin = createClient(
      Deno.env.get("SUPABASE_URL") || SUPABASE_URL,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    );
    const r = await createNativeTenantAndFranchise(
      sbAdmin,
      opts.companyName || (opts.email.split("@")[1] || ""),
    );
    franchiseId = r.franchiseId;
  } catch (e) {
    console.error("Native provision (signup) failed:", e);
    return { error: "native_provision_failed" };
  }

  // Insert the owner profile. on_conflict=email merges on the rare concurrent double-submit.
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?on_conflict=email`,
      {
        method: "POST",
        headers: { ...SB_HEADERS, "Prefer": "return=representation,resolution=merge-duplicates" },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          auth_user_id: opts.authUserId,
          email: opts.email,
          name: opts.name,
          role: "owner",
          franchise_id: franchiseId,
        }),
      },
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }
  } catch (e) {
    console.error("Profile insert (signup) failed:", e);
    return { error: "profile_create_failed" };
  }

  const hydrated = await lookupProfile(opts.email);
  return hydrated ? { profile: hydrated } : { error: "profile_create_failed" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6: Build the session object that the frontend will consume
// ─────────────────────────────────────────────────────────────────────────────
function buildSession(opts: {
  profile: any;
  userInfo: any;
  googleAccessToken: string;
  supabaseAccessToken: string | null;
  inviteToken: string | null;
}): Record<string, unknown> {
  const { profile, userInfo, googleAccessToken, supabaseAccessToken, inviteToken } = opts;
  const f = profile.franchises || {};
  const cs = f.cost_settings || {};
  const t = f.tenants || {};

  const session: Record<string, unknown> = {
    token: googleAccessToken,
    name: profile.name || userInfo.name,
    email: userInfo.email,
    role: profile.role || "owner",
    franchiseID: f.external_id || null,
    franchiseInternalID: profile.franchise_id || null,
    tenantID: t.id || null,
    // Per-capability provider seam (CL-SPEC-001 §3). Default to vonigo so any tenant
    // missing the columns (pre-migration / stale cache) keeps current behavior; new
    // self-serve tenants carry their own native defaults from the DB.
    pricingSource: t.pricing_source || "vonigo",
    customerSource: t.customer_source || "vonigo",
    submissionTarget: t.submission_target || "vonigo",
    franchiseName: f.franchise_name || null,
    // Access value preference, franchise-first (matches buildSessionFromSupabaseAuth): per-franchise
    // status > franchise tier > tenant status. Lets one franchise in a shared tenant run its own trial.
    subscriptionStatus: (function () {
      const ACCESS = ["active", "trialing", "tester", "pro", "enterprise"];
      const fs = f.subscription_status, ft = f.subscription_tier, ts = t.subscription_status;
      if (ACCESS.indexOf(fs) !== -1) return fs;
      if (ACCESS.indexOf(ft) !== -1) return ft;
      if (ACCESS.indexOf(ts) !== -1) return ts;
      return fs || ft || ts || "trialing";
    })(),
    trialEndsAt: f.trial_ends_at || profile.pending_trial_ends_at || t.trial_ends_at || null,
    vonigoConfigured: f.vonigo_configured || false,
    supabaseToken: supabaseAccessToken,
    phone: cs.phone || "",
    website: cs.website || "",
    officeAddress: cs.officeAddress || "",
    officeCity: cs.officeCity || "",
    officeState: cs.officeState || "",
    officeZip: cs.officeZip || "",
  };

  if (inviteToken) {
    session.inviteToken = inviteToken;
  }

  return session;
}

// ─────────────────────────────────────────────────────────────────────────────
// Redirect helpers
// ─────────────────────────────────────────────────────────────────────────────
function redirectSession(session: Record<string, unknown>): Response {
  const url = `${APP_BASE}/?session=${encodeURIComponent(JSON.stringify(session))}`;
  return new Response(null, {
    status: 302,
    headers: { "Location": url },
  });
}

function redirectError(errorCode: string, email: string): Response {
  const params = new URLSearchParams({ auth_error: errorCode });
  if (email) params.set("email", email);
  const url = `${APP_BASE}/?${params.toString()}`;
  return new Response(null, {
    status: 302,
    headers: { "Location": url },
  });
}