// Supabase Edge Function: crewlogic-quickbooks (v0.1)
// QuickBooks Online OAuth2 + reclass JournalEntry auto-post (super-admin / #90-internal only).
//
// Flow:
//   POST {action:"authUrl", franchiseID}      → { url } to open Intuit's consent screen
//   GET  ?code=&realmId=&state=<franchiseID>   → OAuth redirect target: exchange code → store tokens
//   POST {action:"status", franchiseID}        → { connected, environment, realmId, expiresAt }
//   POST {action:"disconnect", franchiseID}    → clears tokens
//   POST {action:"postJE", franchiseID, month:"2026-06", txnDate, amounts:{disposal,supplies,maintenance,other}}
//          → resolves account IDs by GL #, builds the reclass JE (debit non-gas, credit gas the sum), POSTs it
//
// Secrets: QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_ENV(sandbox|production), QBO_REDIRECT_URI (must match the
// URI registered in the Intuit app — this function's URL). Tokens live in quickbooks_credentials (service role).
//
// Deploy (DEV): supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-quickbooks --use-api --no-verify-jwt

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CLIENT_ID = Deno.env.get("QBO_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("QBO_CLIENT_SECRET") || "";
const QBO_ENV = (Deno.env.get("QBO_ENV") || "sandbox").toLowerCase();
const REDIRECT_URI = Deno.env.get("QBO_REDIRECT_URI") || "";
const AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const API_BASE = QBO_ENV === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
const SCOPE = "com.intuit.quickbooks.accounting";

// Reclass category → QuickBooks GL account number (Luggers Northeast COA, validated 2026-07-16).
const ACCT_NUM: Record<string, string> = {
  gas: "5101-00", disposal: "5051-00", supplies: "5151-00", maintenance: "5102-00", other: "8100-00",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function html(body: string): Response {
  return new Response("<!doctype html><meta charset=utf-8><body style='font-family:system-ui;background:#0f1a26;color:#eef4fa;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;'>" + body + "</body>", { headers: { "Content-Type": "text/html" } });
}

async function sbFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  return await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
}
async function getCreds(franchiseID: string): Promise<any | null> {
  const r = await sbFetch("quickbooks_credentials?franchise_id=eq." + encodeURIComponent(franchiseID) + "&select=*");
  if (!r.ok) return null;
  const rows = await r.json();
  return (rows && rows[0]) || null;
}
async function saveCreds(franchiseID: string, patch: Record<string, unknown>): Promise<void> {
  await sbFetch("quickbooks_credentials?on_conflict=franchise_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ franchise_id: franchiseID, environment: QBO_ENV, updated_at: new Date().toISOString(), ...patch }),
  });
}

// Exchange an auth code OR refresh token for a fresh token set.
async function tokenRequest(params: Record<string, string>): Promise<any> {
  const basic = btoa(CLIENT_ID + ":" + CLIENT_SECRET);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("token " + res.status + ": " + JSON.stringify(data).slice(0, 200));
  return data;
}

// Valid access token for the franchise, refreshing if expired.
async function accessToken(franchiseID: string): Promise<{ token: string; realm: string }> {
  const c = await getCreds(franchiseID);
  if (!c || !c.refresh_token || !c.realm_id) throw new Error("QuickBooks not connected");
  const expMs = c.expires_at ? new Date(c.expires_at).getTime() : 0;
  if (c.access_token && expMs - 60000 > Date.now()) return { token: c.access_token, realm: c.realm_id };
  // refresh
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: c.refresh_token });
  await saveCreds(franchiseID, {
    access_token: t.access_token, refresh_token: t.refresh_token || c.refresh_token,
    expires_at: new Date(Date.now() + (Number(t.expires_in || 3600) * 1000)).toISOString(),
  });
  return { token: t.access_token, realm: c.realm_id };
}

async function qboQuery(token: string, realm: string, query: string): Promise<any> {
  const url = API_BASE + "/v3/company/" + realm + "/query?minorversion=65&query=" + encodeURIComponent(query);
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("qbo query " + res.status + ": " + JSON.stringify(data).slice(0, 200));
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

  // OAuth redirect target (Intuit sends the browser here via GET with ?code&realmId&state).
  if (req.method === "GET" && url.searchParams.get("code")) {
    try {
      const code = url.searchParams.get("code")!;
      const realmId = url.searchParams.get("realmId") || "";
      const franchiseID = url.searchParams.get("state") || "";
      if (!franchiseID || !realmId) return html("❌ Missing state/realm — try connecting again.");
      const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
      await saveCreds(franchiseID, {
        realm_id: realmId, access_token: t.access_token, refresh_token: t.refresh_token,
        expires_at: new Date(Date.now() + (Number(t.expires_in || 3600) * 1000)).toISOString(),
        connected_at: new Date().toISOString(),
      });
      return html("<div><h2>✅ QuickBooks connected</h2><p>Company realm " + realmId + " (" + QBO_ENV + "). You can close this tab and return to CrewLogic.</p></div>");
    } catch (e) {
      return html("❌ Connect failed: " + (e as Error).message);
    }
  }

  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const body = await req.json();
    const action = String(body.action || "");
    const franchiseID = String(body.franchiseID || "").trim();
    if (!franchiseID) return json({ success: false, error: "franchiseID required" }, 400);

    if (action === "authUrl") {
      if (!CLIENT_ID || !REDIRECT_URI) return json({ success: false, error: "QBO_CLIENT_ID / QBO_REDIRECT_URI not configured" }, 500);
      const u = new URL(AUTH_BASE);
      u.searchParams.set("client_id", CLIENT_ID);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", SCOPE);
      u.searchParams.set("redirect_uri", REDIRECT_URI);
      u.searchParams.set("state", franchiseID);
      return json({ success: true, url: u.toString(), environment: QBO_ENV });
    }

    if (action === "status") {
      const c = await getCreds(franchiseID);
      return json({ success: true, connected: !!(c && c.refresh_token && c.realm_id), environment: (c && c.environment) || QBO_ENV, realmId: (c && c.realm_id) || null, connectedAt: (c && c.connected_at) || null });
    }

    if (action === "disconnect") {
      await sbFetch("quickbooks_credentials?franchise_id=eq." + encodeURIComponent(franchiseID), { method: "DELETE", headers: { Prefer: "return=minimal" } });
      return json({ success: true, connected: false });
    }

    if (action === "postJE") {
      const amounts = body.amounts || {}; // { disposal, supplies, maintenance, other } in dollars
      const txnDate = String(body.txnDate || "").trim() || new Date().toISOString().slice(0, 10);
      const memo = String(body.memo || "CrewLogic Motive card reclass" + (body.month ? " — " + body.month : ""));
      const { token, realm } = await accessToken(franchiseID);

      // Resolve GL account numbers → QBO account Ids.
      const acctData = await qboQuery(token, realm, "select Id, Name, AcctNum from Account");
      const byNum: Record<string, string> = {};
      for (const a of (acctData.QueryResponse?.Account || [])) if (a.AcctNum) byNum[String(a.AcctNum)] = String(a.Id);
      const idFor = (cat: string) => byNum[ACCT_NUM[cat]];

      const lines: any[] = [];
      let creditSum = 0;
      const missing: string[] = [];
      for (const cat of ["disposal", "supplies", "maintenance", "other"]) {
        const amt = Math.round(Number(amounts[cat] || 0) * 100) / 100;
        if (amt <= 0) continue;
        const id = idFor(cat);
        if (!id) { missing.push(cat + " (" + ACCT_NUM[cat] + ")"); continue; }
        creditSum += amt;
        lines.push({ Amount: amt, DetailType: "JournalEntryLineDetail", Description: memo, JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: id } } });
      }
      const gasId = idFor("gas");
      if (!gasId) missing.push("gas (" + ACCT_NUM.gas + ")");
      if (missing.length) return json({ success: false, error: "Account(s) not found in this QuickBooks company: " + missing.join(", ") }, 400);
      if (creditSum <= 0) return json({ success: false, error: "Nothing to reclass (all non-gas amounts are $0)." }, 400);
      creditSum = Math.round(creditSum * 100) / 100;
      lines.push({ Amount: creditSum, DetailType: "JournalEntryLineDetail", Description: memo, JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: gasId } } });

      const jeRes = await fetch(API_BASE + "/v3/company/" + realm + "/journalentry?minorversion=65", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ Line: lines, TxnDate: txnDate, PrivateNote: memo }),
      });
      const jeData = await jeRes.json().catch(() => ({}));
      if (!jeRes.ok) { console.error("[qbo] postJE", jeRes.status, JSON.stringify(jeData).slice(0, 300)); return json({ success: false, error: "QuickBooks rejected the entry.", detail: jeData?.Fault || jeData }, 502); }
      const je = jeData.JournalEntry || {};
      return json({ success: true, journalEntryId: je.Id, docNumber: je.DocNumber, total: creditSum, txnDate, environment: QBO_ENV });
    }

    return json({ success: false, error: "Unknown action" }, 400);
  } catch (e) {
    console.error("[crewlogic-quickbooks] error:", (e as Error)?.stack || String(e));
    return json({ success: false, error: (e as Error).message || "QuickBooks request failed." }, 500);
  }
});
