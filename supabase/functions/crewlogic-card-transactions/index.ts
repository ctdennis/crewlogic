// Supabase Edge Function: crewlogic-card-transactions (v0.1 — discovery/classify)
// Pulls Motive Card transactions (GET /motive_card/v1/transactions) for a date range and classifies
// each as gas | disposal | other for monthly P&L reclass. Motive card transactions currently all post
// to the P&L as "gas"; this surfaces the disposal + other ones so they can be reclassed.
//
// Auth: same Motive x-api-key as crewlogic-trucks — per-franchise via get_telematics_credential(),
// with the global MOTIVE_API_KEY secret as fallback. The key NEVER reaches the client.
//
// Request: { franchiseID:"90", start_date:"2026-06-01", end_date:"2026-06-30" }
// Response: { success, range, counts, totals:{gas,disposal,other}, byProductType, merchants,
//             transactions:[ {id, time, merchant, city, state, amount, productTypes, category, invoice} ] }
//
// Deploy (DEV): supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb crewlogic-card-transactions --use-api --no-verify-jwt

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CARD_URL = "https://api.gomotive.com/motive_card/v1/transactions";

type Cat = "gas" | "disposal" | "supplies" | "maintenance" | "other";
const CATS: Cat[] = ["gas", "disposal", "supplies", "maintenance", "other"];
// product_type → default category (verified against #90's merchants):
//   fuel                                    → gas
//   Business & professional services / Utilities (TOWN OF BOURNE, JRV, WM transfer) → disposal
//   Hardware stores (HOME DEPOT)            → supplies
//   Maintenance / Tires (AUTOZONE, USED TIRE WAREHOUSE, ADVANCE AUTO) → maintenance
//   everything else                         → other
// Any vendor can be OVERRIDDEN in card_merchant_overrides.
const GAS_TYPES = new Set([
  "Gasoline", "Diesel", "Miscellaneous Fuel", "DEF", "Reefer Fuel", "Fuel station purchases", "Gasohol",
]);
const DISPOSAL_TYPES = new Set(["Business & professional services", "Utilities"]);
const SUPPLY_TYPES = new Set(["Hardware stores"]);
const MAINT_TYPES = new Set(["Maintenance", "Tires"]);
// Auto-category for a MERCHANT from its product_types (fuel wins for gas stations that also show Maintenance).
// A merchant is consistently ONE category, so its no-product_type charges inherit it too.
function autoCategory(productTypes: Set<string>): Cat {
  for (const t of productTypes) if (GAS_TYPES.has(t)) return "gas";
  for (const t of productTypes) if (DISPOSAL_TYPES.has(t)) return "disposal";
  for (const t of productTypes) if (SUPPLY_TYPES.has(t)) return "supplies";
  for (const t of productTypes) if (MAINT_TYPES.has(t)) return "maintenance";
  return "other";
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Super-admin gate: this is a #90-internal reclass tool, not a customer feature. The frontend sends the
// owner's Supabase JWT (via _crEdge); we resolve it to a user and require the super-admin email. The public
// anon key resolves to role=anon with no email, so it (and any unauthenticated caller) is rejected.
const SUPER_ADMIN_EMAIL = "charles.dennis@junkluggers.com";
async function isSuperAdmin(req: Request): Promise<boolean> {
  try {
    const tokenHdr = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!tokenHdr) return false;
    const r = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { Authorization: "Bearer " + tokenHdr, apikey: SERVICE_KEY } });
    if (!r.ok) return false;
    const u = await r.json();
    return String(u?.email || "").toLowerCase() === SUPER_ADMIN_EMAIL;
  } catch (_e) { return false; }
}

// Resolve the Motive Card API key. The card API is ACCOUNT-level and (per the sample key) uses its OWN
// key distinct from the fleet/geofence key — so prefer a dedicated MOTIVE_CARD_API_KEY secret. Fall back
// to the per-franchise Motive token, then the global MOTIVE_API_KEY, in case the account shares one key.
async function motiveToken(franchiseID: string): Promise<string> {
  const cardKey = Deno.env.get("MOTIVE_CARD_API_KEY");
  if (cardKey) return cardKey;
  try {
    const res = await fetch(SUPABASE_URL + "/rest/v1/rpc/get_telematics_credential", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ p_franchise_id: franchiseID }),
    });
    if (res.ok) {
      const rows = await res.json();
      const row = Array.isArray(rows) ? rows[0] : null;
      if (row && String(row.provider || "").toLowerCase() === "motive" && row.token) return String(row.token);
    }
  } catch (_e) { /* fall through to global */ }
  return Deno.env.get("MOTIVE_API_KEY") || "";
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// Load the saved per-vendor overrides (service role; the client never reads this table directly).
async function loadOverrides(franchiseID: string): Promise<Record<string, Cat>> {
  const res = await fetch(SUPABASE_URL + "/rest/v1/card_merchant_overrides?franchise_id=eq." + encodeURIComponent(franchiseID) + "&select=merchant_name,category", {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const map: Record<string, Cat> = {};
  if (res.ok) { const rows = await res.json(); for (const r of (rows || [])) map[String(r.merchant_name)] = r.category as Cat; }
  return map;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 405);

  try {
    if (!(await isSuperAdmin(req))) return jsonResponse({ success: false, error: "Not authorized" }, 403);
    const body = await req.json();
    const franchiseID = String(body.franchiseID || "").trim();
    const action = String(body.action || "").trim();
    if (!franchiseID) return jsonResponse({ success: false, error: "franchiseID required" }, 400);

    // SAVE a per-vendor override: { action:"saveOverride", franchiseID, merchant_name, category }
    if (action === "saveOverride") {
      const merchant_name = String(body.merchant_name || "").trim();
      const category = String(body.category || "").trim();
      if (!merchant_name || !CATS.includes(category as Cat)) {
        return jsonResponse({ success: false, error: "merchant_name + valid category (" + CATS.join("|") + ") required" }, 400);
      }
      const up = await fetch(SUPABASE_URL + "/rest/v1/card_merchant_overrides?on_conflict=franchise_id,merchant_name", {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ franchise_id: franchiseID, merchant_name, category, updated_at: new Date().toISOString() }),
      });
      if (!up.ok) { const t = await up.text(); console.error("[card-transactions] saveOverride", up.status, t.slice(0, 200)); return jsonResponse({ success: false, error: "Could not save override." }, 500); }
      return jsonResponse({ success: true, merchant_name, category });
    }

    const start_date = String(body.start_date || "").trim();
    const end_date = String(body.end_date || "").trim();
    const token = await motiveToken(franchiseID);
    if (!token) return jsonResponse({ success: false, error: "No Motive credential for this franchise." }, 404);

    // CASH BASIS: the panel asks for a calendar month, but the Motive card posts to QuickBooks as WEEKLY
    // statement payments (~2-3 days after the statement's last swipe). So we reclass by the month a statement
    // was PAID, not by swipe date. Fetch a padded window, keep only SETTLED transactions, group them into
    // statements by invoice_number, date each statement paid = last-swipe + PAY_LAG_DAYS, and include only the
    // statements paid inside [start_date, end_date]. Dropping non-settled also removes the volatile declined
    // $999 pre-auth holds that made totals jump load-to-load.
    const addDaysISO = (iso: string, n: number): string => {
      const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
    };
    const PAY_LAG_DAYS = 3;
    const fetchStart = start_date ? addDaysISO(start_date, -14) : "";
    const fetchEnd = end_date ? addDaysISO(end_date, 6) : "";

    // Page through the padded window (per_page 1000).
    const all: any[] = [];
    for (let page = 1; page <= 20; page++) {
      const qs = new URLSearchParams({ sort_direction: "desc", page_no: String(page), per_page: "1000" });
      if (fetchStart && fetchEnd) { qs.set("date_range_filter_type", "transaction_time"); qs.set("start_date", fetchStart); qs.set("end_date", fetchEnd); }
      const res = await fetch(CARD_URL + "?" + qs.toString(), { headers: { accept: "application/json", "x-api-key": token } });
      if (!res.ok) { const t = await res.text(); return jsonResponse({ success: false, error: `Motive card API ${res.status}`, detail: t.slice(0, 300) }, 502); }
      const data = await res.json();
      const batch: any[] = data.transactions || [];
      all.push(...batch);
      if (batch.length < 1000) break;
    }

    // Unwrap + keep only SETTLED transactions (drop declined/reversed/pending $999 pre-auth holds).
    const SETTLED = new Set(["posted", "completed"]);
    const settled = all.map((raw: any) => (raw && raw.transaction) ? raw.transaction : raw)
      .filter((t: any) => SETTLED.has(String(t.transaction_status || "")));

    // Group into weekly statements by invoice; a statement's PAY date = its last swipe + PAY_LAG_DAYS.
    const stmtLast: Record<string, string> = {};
    for (const t of settled) { const k = String(t.invoice_number || "(none)"); const d = String(t.transaction_time || "").slice(0, 10); if (d && d > (stmtLast[k] || "")) stmtLast[k] = d; }
    const paidInMonth = (invoiceKey: string): boolean => {
      const last = stmtLast[invoiceKey]; if (!last) return false;
      const pay = addDaysISO(last, PAY_LAG_DAYS);
      return (!start_date || pay >= start_date) && (!end_date || pay <= end_date);
    };

    // Aggregate by MERCHANT (a vendor is one category), from transactions whose statement was PAID this month.
    const overrides = await loadOverrides(franchiseID);
    const M: Record<string, { total: number; count: number; types: Set<string> }> = {};
    const lineItems: any[] = [];
    for (const t of settled) {
      if (!paidInMonth(String(t.invoice_number || "(none)"))) continue;
      const amount = Number(t.total_amount_after_rebate_in_micros || 0) / 1e6; // micros → dollars
      const name = String(t.merchant_info?.name || "(unknown)");
      const ptypes = (t.order_items || []).map((o: any) => String(o.product_type || "")).filter(Boolean);
      const m = M[name] || (M[name] = { total: 0, count: 0, types: new Set<string>() });
      m.total += amount; m.count += 1; for (const p of ptypes) m.types.add(p);
      lineItems.push({ id: t.id, time: t.transaction_time, merchant: name, city: t.merchant_info?.city || "", state: String(t.merchant_info?.state || "").trim(), amount: r2(amount), productTypes: [...new Set(ptypes)], invoice: String(t.invoice_number || ""), lastFour: t.last_four_digits || "" });
    }

    // Per-merchant: auto category from product_types, override, effective (override || auto), isNew (untagged).
    const merchants = Object.entries(M).map(([name, m]) => {
      const auto = autoCategory(m.types);
      const override = overrides[name] || null;
      return { name, total: r2(m.total), count: m.count, productTypes: [...m.types], auto, override, effective: (override || auto) as Cat, isNew: !(name in overrides) };
    }).sort((a, b) => b.total - a.total);

    const totals = Object.fromEntries(CATS.map((k) => [k, 0])) as Record<Cat, number>;
    const counts = Object.fromEntries(CATS.map((k) => [k, 0])) as Record<Cat, number>;
    const catByMerchant: Record<string, Cat> = {};
    for (const mm of merchants) { totals[mm.effective] += mm.total; counts[mm.effective] += mm.count; catByMerchant[mm.name] = mm.effective; }
    for (const k of Object.keys(totals) as Cat[]) totals[k] = r2(totals[k]);
    for (const li of lineItems) li.category = catByMerchant[li.merchant] || "other";

    return jsonResponse({ success: true, basis: "payment", range: { start_date, end_date }, fetched: { start_date: fetchStart, end_date: fetchEnd }, count: lineItems.length, totals, counts, merchants, transactions: lineItems });
  } catch (e) {
    console.error("[card-transactions] error:", (e as Error)?.stack || String(e));
    return jsonResponse({ success: false, error: "Card transaction fetch failed." }, 500);
  }
});
