// Supabase Edge Function: crewlogic-trucks (v3.0 — per-franchise + persistent ordering)
// Returns current truck GPS locations for a franchise, normalized to data.trucks, SORTED by the
// franchise's saved map order (see franchise_trucks / migration 0035). Also serves the Truck Setup
// modal: action=setupList (sync feed + return the full fleet ordered) and action=reorder (persist
// the drag/drop order). The green map-dot numbers follow this order so "Truck 1" is always the
// same truck instead of the arbitrary API-return sequence.
//
// PRIMARY path (per-franchise): caller passes ?franchiseID=<uuid> (or POST body { franchiseID }).
// We resolve that franchise's provider + token from Vault via the service-role-only RPC
// get_telematics_credential(), then pull from the matching provider. The token NEVER reaches the
// client. All franchise_trucks reads/writes are service-role (this function), so that table stays
// RLS service-role-only and the client never touches it directly.
//
// LEGACY/TEST fallback: if no franchiseID is given, fall back to the old global behavior —
// ?provider=motive|linxup using the global MOTIVE_API_KEY / LINXUP_API_KEY secrets.
//
// SECRETS / ENV:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — injected; used for the RPC + franchise_trucks REST
//   MOTIVE_API_KEY, LINXUP_API_KEY          — legacy fallback only
//
// Normalized response (position call):
//   { success, provider, trucks: [ { number, name, lat, lon, speed, heading, status, lastUpdate,
//                                    make, model, year, vin, desc, key, sortOrder } ] }
// setupList response:
//   { success, provider, trucks: [ { key, name, number, vin, active, sortOrder } ] }

import { fetchTrucks } from "../_shared/telematics.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

type Truck = Record<string, unknown>;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Resolve a franchise's provider + decrypted token via the service-role RPC.
async function getFranchiseCredential(
  franchiseID: string,
): Promise<{ provider: string; token: string } | null> {
  const res = await fetch(SUPABASE_URL + "/rest/v1/rpc/get_telematics_credential", {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_franchise_id: franchiseID }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error(`[crewlogic-trucks] get_telematics_credential ${res.status}: ${txt.slice(0, 200)}`);
    return null;
  }
  const rows = await res.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return { provider: String(rows[0].provider || ""), token: String(rows[0].token || "") };
}

// ── franchise_trucks persistence (service-role REST) ─────────────────────────
// Stable identity: VIN when present (survives a rename in the telematics portal), else the name.
function truckKey(t: Truck): string {
  const vin = String((t.vin ?? "")).trim();
  if (vin) return "vin:" + vin.toUpperCase();
  const name = String((t.name ?? "")).trim();
  if (name) return "name:" + name.toLowerCase();
  const num = String((t.number ?? "")).trim();
  return "num:" + (num || "unknown").toLowerCase();
}

async function ftRest(
  path: string,
  opts: { method?: string; body?: unknown; prefer?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    apikey: SERVICE_KEY,
    Authorization: "Bearer " + SERVICE_KEY,
    "Content-Type": "application/json",
  };
  if (opts.prefer) headers["Prefer"] = opts.prefer;
  return await fetch(SUPABASE_URL + "/rest/v1/franchise_trucks" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

// Annotate live trucks with their saved sort order and sort (unknown last, name tiebreak).
async function attachOrder(franchiseID: string, trucks: Truck[]): Promise<Truck[]> {
  const res = await ftRest("?franchise_id=eq." + franchiseID + "&select=truck_key,sort_order");
  const rows: Array<{ truck_key: string; sort_order: number }> = res.ok
    ? await res.json().catch(() => [])
    : [];
  const orderByKey = new Map(rows.map((r) => [r.truck_key, r.sort_order]));
  const annotated = trucks.map((t) => {
    const key = truckKey(t);
    const so = orderByKey.has(key) ? (orderByKey.get(key) as number) : Number.MAX_SAFE_INTEGER;
    return { ...t, key, sortOrder: so };
  });
  annotated.sort((a, b) =>
    (a.sortOrder as number) - (b.sortOrder as number) ||
    String(a.name ?? "").localeCompare(String(b.name ?? "")));
  return annotated;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Parse inputs from query string and/or POST body.
  const url = new URL(req.url);
  let franchiseID = url.searchParams.get("franchiseID") || "";
  let provider = url.searchParams.get("provider") || "";
  let action = url.searchParams.get("action") || "";
  let order: string[] = [];
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    franchiseID = franchiseID || String((body as { franchiseID?: unknown }).franchiseID || "");
    provider = provider || String((body as { provider?: unknown }).provider || "");
    action = action || String((body as { action?: unknown }).action || "");
    const ord = (body as { order?: unknown }).order;
    if (Array.isArray(ord)) order = ord.map((k) => String(k));
  }

  try {
    // PRIMARY: per-franchise resolution
    if (franchiseID) {
      const cred = await getFranchiseCredential(franchiseID);
      if (!cred || !cred.provider || !cred.token) {
        return jsonResponse(
          { success: false, error: "No telematics provider configured for this franchise." },
          404,
        );
      }

      // reorder: persist the drag/drop order (index = new sort_order). No feed fetch needed.
      if (action === "reorder") {
        const nowIso = new Date().toISOString();
        await Promise.all(order.map((key, idx) =>
          ftRest(
            "?franchise_id=eq." + franchiseID + "&truck_key=eq." + encodeURIComponent(key),
            { method: "PATCH", body: { sort_order: idx, updated_at: nowIso }, prefer: "return=minimal" },
          )
        ));
        return jsonResponse({ success: true });
      }

      const result = await fetchTrucks(cred.provider, cred.token);
      if (!result.success) return jsonResponse(result, 502);
      const trucks = (result.trucks || []) as Truck[];

      // setupList: sync the feed into franchise_trucks, then return the FULL fleet (live + offline)
      // in saved order so the modal can arrange every known truck even if some are parked/offline.
      if (action === "setupList") {
        const exRes = await ftRest(
          "?franchise_id=eq." + franchiseID + "&select=truck_key,sort_order",
        );
        const exRows: Array<{ truck_key: string; sort_order: number }> = exRes.ok
          ? await exRes.json().catch(() => [])
          : [];
        const exByKey = new Map(exRows.map((r) => [r.truck_key, r.sort_order]));
        let maxOrder = exRows.reduce((m, r) => Math.max(m, r.sort_order), -1);
        const nowIso = new Date().toISOString();

        // 1) mark all existing rows inactive; live ones are re-activated by the upsert below
        await ftRest("?franchise_id=eq." + franchiseID, {
          method: "PATCH",
          body: { active: false, updated_at: nowIso },
          prefer: "return=minimal",
        });
        // 2) upsert live trucks — new ones append to the end of the order, existing keep their slot
        const upserts = trucks.map((t) => {
          const key = truckKey(t);
          const sort_order = exByKey.has(key) ? (exByKey.get(key) as number) : ++maxOrder;
          return {
            franchise_id: franchiseID,
            truck_key: key,
            name: String(t.name ?? "") || null,
            vin: String(t.vin ?? "") || null,
            provider: cred.provider,
            sort_order,
            active: true,
            updated_at: nowIso,
          };
        });
        if (upserts.length) {
          await ftRest("?on_conflict=franchise_id,truck_key", {
            method: "POST",
            body: upserts,
            prefer: "resolution=merge-duplicates,return=minimal",
          });
        }
        // 3) re-fetch the full saved fleet (ordered) and flag which are currently live
        const liveByKey = new Map(trucks.map((t) => [truckKey(t), t]));
        const savedRes = await ftRest(
          "?franchise_id=eq." + franchiseID +
            "&select=truck_key,name,vin,sort_order,active&order=sort_order",
        );
        const saved: Array<{ truck_key: string; name: string | null; vin: string | null; sort_order: number }> =
          savedRes.ok ? await savedRes.json().catch(() => []) : [];
        const list = saved.map((r) => {
          const live = liveByKey.get(r.truck_key) as Truck | undefined;
          return {
            key: r.truck_key,
            name: (live && String(live.name ?? "")) || r.name || r.truck_key,
            number: live ? (live.number ?? null) : null,
            vin: r.vin,
            active: !!live,
            sortOrder: r.sort_order,
          };
        });
        return jsonResponse({ success: true, provider: cred.provider, trucks: list });
      }

      // default position call: return live trucks sorted by the saved order
      const ordered = await attachOrder(franchiseID, trucks);
      return jsonResponse({ success: true, provider: cred.provider, trucks: ordered });
    }

    // LEGACY/TEST fallback: global env secrets by provider (no persistence/ordering)
    provider = (provider || "motive").toLowerCase();
    const envToken =
      provider === "linxup" ? Deno.env.get("LINXUP_API_KEY") : Deno.env.get("MOTIVE_API_KEY");
    if (!envToken) {
      return jsonResponse(
        { success: false, error: `${provider.toUpperCase()}_API_KEY not configured` },
        500,
      );
    }
    const result = await fetchTrucks(provider, envToken);
    return jsonResponse(result, result.success ? 200 : 502);
  } catch (e) {
    const err = e as Error;
    console.error("[crewlogic-trucks] error:", err?.message || err);
    return jsonResponse({ success: false, error: err.message || "Internal error" }, 500);
  }
});
