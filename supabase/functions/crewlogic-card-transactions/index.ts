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

type Cat = "gas" | "disposal" | "other";
// product_type → default category. Fuel = gas; disposal sites code as these generic service types (verified
// against #90's merchants: TOWN OF BOURNE / JRV Shun Pike = "Business & professional services", WM transfer =
// "Utilities"). Everything else defaults to "other". Any vendor can be OVERRIDDEN in card_merchant_overrides.
const GAS_TYPES = new Set([
  "Gasoline", "Diesel", "Miscellaneous Fuel", "DEF", "Reefer Fuel", "Fuel station purchases", "Gasohol",
]);
const DISPOSAL_TYPES = new Set(["Business & professional services", "Utilities"]);
// Auto-category for a MERCHANT from the product_types seen across its transactions: gas if any fuel, else
// disposal if any disposal-type, else other. A merchant is consistently ONE category (so its no-product_type
// charges inherit it too).
function autoCategory(productTypes: Set<string>): Cat {
  for (const t of productTypes) if (GAS_TYPES.has(t)) return "gas";
  for (const t of productTypes) if (DISPOSAL_TYPES.has(t)) return "disposal";
  return "other";
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
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
    const body = await req.json();
    const franchiseID = String(body.franchiseID || "").trim();
    const action = String(body.action || "").trim();
    if (!franchiseID) return jsonResponse({ success: false, error: "franchiseID required" }, 400);

    // SAVE a per-vendor override: { action:"saveOverride", franchiseID, merchant_name, category }
    if (action === "saveOverride") {
      const merchant_name = String(body.merchant_name || "").trim();
      const category = String(body.category || "").trim();
      if (!merchant_name || !["gas", "disposal", "other"].includes(category)) {
        return jsonResponse({ success: false, error: "merchant_name + valid category (gas|disposal|other) required" }, 400);
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

    // Page through all transactions in the range (per_page 1000).
    const all: any[] = [];
    for (let page = 1; page <= 20; page++) {
      const qs = new URLSearchParams({ sort_direction: "desc", page_no: String(page), per_page: "1000" });
      if (start_date && end_date) { qs.set("date_range_filter_type", "transaction_time"); qs.set("start_date", start_date); qs.set("end_date", end_date); }
      const res = await fetch(CARD_URL + "?" + qs.toString(), { headers: { accept: "application/json", "x-api-key": token } });
      if (!res.ok) { const t = await res.text(); return jsonResponse({ success: false, error: `Motive card API ${res.status}`, detail: t.slice(0, 300) }, 502); }
      const data = await res.json();
      const batch: any[] = data.transactions || [];
      all.push(...batch);
      if (batch.length < 1000) break;
    }

    // Aggregate by MERCHANT (a vendor is one category); collect its product_types + build line items.
    const overrides = await loadOverrides(franchiseID);
    const M: Record<string, { total: number; count: number; types: Set<string> }> = {};
    const lineItems: any[] = [];
    for (const raw of all) {
      const t = (raw && raw.transaction) ? raw.transaction : raw; // Motive wraps each item in {transaction:{...}}
      const amount = Number(t.total_amount_after_rebate_in_micros || 0) / 1e6; // micros → dollars
      const name = String(t.merchant_info?.name || "(unknown)");
      const ptypes = (t.order_items || []).map((o: any) => String(o.product_type || "")).filter(Boolean);
      const m = M[name] || (M[name] = { total: 0, count: 0, types: new Set<string>() });
      m.total += amount; m.count += 1; for (const p of ptypes) m.types.add(p);
      lineItems.push({ id: t.id, time: t.transaction_time, merchant: name, city: t.merchant_info?.city || "", state: String(t.merchant_info?.state || "").trim(), amount: r2(amount), productTypes: [...new Set(ptypes)], invoice: t.invoice_number || "", lastFour: t.last_four_digits || "" });
    }

    // Per-merchant: auto category from product_types, override, effective (override || auto), isNew (untagged).
    const merchants = Object.entries(M).map(([name, m]) => {
      const auto = autoCategory(m.types);
      const override = overrides[name] || null;
      return { name, total: r2(m.total), count: m.count, productTypes: [...m.types], auto, override, effective: (override || auto) as Cat, isNew: !(name in overrides) };
    }).sort((a, b) => b.total - a.total);

    const totals: Record<Cat, number> = { gas: 0, disposal: 0, other: 0 };
    const counts: Record<Cat, number> = { gas: 0, disposal: 0, other: 0 };
    const catByMerchant: Record<string, Cat> = {};
    for (const mm of merchants) { totals[mm.effective] += mm.total; counts[mm.effective] += mm.count; catByMerchant[mm.name] = mm.effective; }
    for (const k of Object.keys(totals) as Cat[]) totals[k] = r2(totals[k]);
    for (const li of lineItems) li.category = catByMerchant[li.merchant] || "other";

    return jsonResponse({ success: true, range: { start_date, end_date }, count: all.length, totals, counts, merchants, transactions: lineItems });
  } catch (e) {
    console.error("[card-transactions] error:", (e as Error)?.stack || String(e));
    return jsonResponse({ success: false, error: "Card transaction fetch failed." }, 500);
  }
});
