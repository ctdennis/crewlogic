// crewlogic-pricing (v1.0) — native price-book lookup for crm_provider='none'.
// Returns the SAME JSON shape as crewlogic-price-lookup so the frontend estimating engine
// (findVolumeItem / matchSurchargeItem / calcVolumePrice*) is unchanged — only the data source
// swaps. IDs are the numeric `num_id` surrogates (the frontend interpolates some unquoted).
//
// Request:  { franchiseID: string, zipCode?: string }   (zip optional → default list)
// Response: { success, zipCode, zoneID:'', priceListID, priceListName, zoneName, blocks:[
//             { priceBlockID, name, sequence, items:[{ priceItemID, name, value, unitOfMeasure, sequence }] } ] }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const franchiseID = String(body.franchiseID || "");
    const zip = body.zipCode ? String(body.zipCode) : (body.zip ? String(body.zip) : "");
    if (!franchiseID) return json({ success: false, error: "franchiseID required" }, 400);

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // franchise external_id → internal id
    const { data: fr } = await sb.from("franchises").select("id").eq("external_id", franchiseID).limit(1).maybeSingle();
    if (!fr) return json({ success: false, error: "Franchise not found: " + franchiseID }, 404);

    // zip → price list; else the franchise's default list
    let priceListId: string | null = null;
    if (zip) {
      const { data: z } = await sb.from("price_list_zips")
        .select("price_list_id").eq("franchise_id", fr.id).eq("zip", zip).maybeSingle();
      if (z) priceListId = z.price_list_id as string;
    }
    if (!priceListId) {
      const { data: def } = await sb.from("price_lists")
        .select("id").eq("franchise_id", fr.id).eq("is_default", true).limit(1).maybeSingle();
      if (!def) return json({ success: false, error: "No default price list configured for this franchise" }, 404);
      priceListId = def.id as string;
    }

    const { data: list } = await sb.from("price_lists").select("num_id, name").eq("id", priceListId).single();
    const { data: blocks } = await sb.from("price_blocks")
      .select("num_id, name, sequence, price_items(num_id, name, value, unit_of_measure, sequence, is_active)")
      .eq("price_list_id", priceListId).order("sequence");

    const shaped = (blocks || []).map((b: Record<string, unknown>) => ({
      priceBlockID: b.num_id,
      name: b.name,
      sequence: b.sequence,
      items: ((b.price_items as Array<Record<string, unknown>>) || [])
        .filter((i) => i.is_active)
        .sort((a, c) => (a.sequence as number) - (c.sequence as number))
        .map((i) => ({
          priceItemID: i.num_id,
          name: i.name,
          value: Number(i.value),
          unitOfMeasure: (i.unit_of_measure as string) || "",
          sequence: i.sequence,
        })),
    }));

    return json({
      success: true,
      zipCode: zip,
      zoneID: "",
      priceListID: list?.num_id,
      priceListName: list?.name || "",
      zoneName: list?.name || "",
      blocks: shaped,
    });
  } catch (e) {
    return json({ success: false, error: (e as Error).message || "Internal error" }, 500);
  }
});
