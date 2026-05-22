// Supabase Edge Function: crewlogic-price-lookup (v1.4)
// Drop-in replacement for the n8n crewlogic-price-lookup webhook.
//
// Improvements over the n8n version:
//   - No n8n overhead (~500-1000ms saved)
//   - Method 2 + Method 3 + Names lookup all run in parallel (~1000ms saved
//     vs sequential)
//   - Accept zipCode OR zoneID as input. When the caller already knows the
//     zone (Pick Job picker), zoneID lookup is more precise — no zip-to-zone
//     ambiguity. zipCode path remains for legacy / manual entry.
//
// v1.4: Fixed names-catalog lookup. Vonigo's /resources/priceLists/ endpoint
//   returns fields named priceListID/priceList (NOT objectID/name as a
//   different schema in their docs suggests). The interface and lookup now
//   match the actual response shape, so franchise-friendly names like
//   "Junk Removal - Regular PL" are correctly used instead of the template
//   name "Junk Removal - 9 Increments".
//
// Deploy: supabase functions deploy crewlogic-price-lookup
//
// Request body (one of zoneID OR zipCode required):
//   {
//     franchiseID: string,   // e.g. "90"
//     zoneID?:     string,   // Vonigo zone objectID (preferred when known)
//     zipCode?:    string,   // 5-digit zip (fallback for manual entry)
//     email?:      string,   // optional, for logging/audit
//   }
//
// Response shape (matches existing n8n contract):
//   {
//     success: true,
//     zipCode: "02360",      // echoed back; empty string if zoneID was used
//     priceListID: 768,
//     priceListName: "Junk Removal - 9 Increments",
//     zoneName: "9 Increments",   // priceListName with "Junk Removal - " and " PL" stripped
//     blocks: [
//       { priceBlockID, name, sequence, items: [...] },
//       ...
//     ]
//   }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TENANT_ID = '946a4535-aa61-45b6-a6fb-9190ff546d41'; // Junkluggers
const VONIGO_BASE = 'https://junkluggers.vonigo.com/api/v1';
const SERVICE_TYPE_ID = '11'; // Junk Removal
const EXCLUDED_BLOCK_IDS = [560]; // Products — hidden from the estimator UI

interface VonigoPriceItem {
  priceItemID: number;
  priceBlockID: number;
  priceListID: number;
  priceItem: string;
  priceBlock: string;
  priceBlockSequence: number;
  priceList: string;
  sequence: number;
  value: number;
  unitOfMeasure: string;
  isActive: boolean;
  isQuantifiable?: boolean;
  isAllowDecimals?: boolean;
  isHourlyPrice?: boolean;
}

async function vonigoLogin(username: string, password: string): Promise<string> {
  const url = new URL(VONIGO_BASE + '/security/login/');
  url.searchParams.set('company', 'Vonigo');
  url.searchParams.set('userName', username);
  url.searchParams.set('password', password);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.errNo !== 0 || !data.securityToken) {
    throw new Error('Vonigo auth failed: ' + (data.errMsg || 'no token returned'));
  }
  return data.securityToken as string;
}

async function fetchPriceItems(
  securityToken: string,
  method: '2' | '3',
  scope: { zoneID?: string; zipCode?: string },
): Promise<VonigoPriceItem[]> {
  const body: Record<string, string> = {
    securityToken,
    method,
    serviceTypeID: SERVICE_TYPE_ID,
    pageNo: '1',
    pageSize: '500',
  };
  if (scope.zoneID) body.zoneID = scope.zoneID;
  if (scope.zipCode) body.zipCode = scope.zipCode;

  const res = await fetch(VONIGO_BASE + '/data/priceLists/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.errNo !== 0) {
    throw new Error('priceLists method ' + method + ' failed: ' + (data.errMsg || 'errNo ' + data.errNo));
  }
  return (data.PriceItems || []) as VonigoPriceItem[];
}

// Fetch the franchise's display-name catalog of price lists. Used to map
// priceListID -> franchise-friendly name ("Regular PL", "Local PL", etc.)
// because /data/priceLists/ returns a template-style name we don't want.
//
// NOTE: Vonigo's response field names for THIS endpoint are different from
// the /system/objects/ schema for the same conceptual object. The actual
// fields returned are: priceListID, priceList, priceListLevelValue,
// serviceTypeID, isActive.
interface VonigoPriceListName {
  priceListID: number;
  priceList: string;
  priceListLevelValue?: number;
  serviceTypeID?: number;
  isActive: boolean;
}
async function fetchPriceListNames(securityToken: string): Promise<VonigoPriceListName[]> {
  const res = await fetch(VONIGO_BASE + '/resources/priceLists/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ securityToken }),
  });
  const data = await res.json();
  if (data.errNo !== 0) {
    // Non-fatal — we have a fallback name from the data endpoint
    return [];
  }
  return (data.PriceLists || []) as VonigoPriceListName[];
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const franchiseID = String(body.franchiseID || '');
    const zoneID = body.zoneID ? String(body.zoneID) : '';
    const zipCode = body.zipCode ? String(body.zipCode) : '';

    if (!franchiseID) {
      return new Response(JSON.stringify({ success: false, error: 'franchiseID required' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    if (!zoneID && !zipCode) {
      return new Response(JSON.stringify({ success: false, error: 'Either zoneID or zipCode required' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    if (zipCode && !zoneID && zipCode.length !== 5) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid zipCode (must be 5 digits)' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // 1) Fetch Vonigo credentials for this franchise
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: franchiseRow, error: franchiseErr } = await supabase
      .from('franchises')
      .select('id')
      .eq('external_id', franchiseID)
      .eq('tenant_id', TENANT_ID)
      .single();

    if (franchiseErr || !franchiseRow) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Franchise not found: ' + franchiseID,
      }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const { data: credRows, error: credErr } = await supabase
      .rpc('get_vonigo_credential', { p_franchise_id: franchiseRow.id });

    if (credErr || !credRows || credRows.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Vonigo credentials not found for franchise ' + franchiseID,
        debug: { rpcError: credErr?.message || null },
      }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    const { vonigo_username, vonigo_md5 } = credRows[0];

    // 2) Authenticate with Vonigo
    const securityToken = await vonigoLogin(vonigo_username, vonigo_md5);

    // 3) Call Method 2, Method 3, and the Names catalog IN PARALLEL.
    //    Method 2/3 fetch the actual price items keyed by zip/zone.
    //    Names returns the franchise-friendly display name catalog
    //    (e.g. "Junk Removal - Regular PL" instead of "9 Increments").
    const scope = zoneID ? { zoneID } : { zipCode };
    const [method2Items, method3Items, priceListNames] = await Promise.all([
      fetchPriceItems(securityToken, '2', scope),
      fetchPriceItems(securityToken, '3', scope),
      fetchPriceListNames(securityToken),
    ]);

    // 4) Merge: method 3 layered on top of method 2 (deduplicated by priceItemID).
    //    Matches existing n8n merge behavior — method 3 only adds items not in
    //    method 2, preserving any overrides.
    const allItems: VonigoPriceItem[] = [...method2Items];
    const seenIDs = new Set(allItems.map((i) => i.priceItemID));
    for (const it of method3Items) {
      if (!seenIDs.has(it.priceItemID)) {
        allItems.push(it);
        seenIDs.add(it.priceItemID);
      }
    }

    if (allItems.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: zoneID
          ? 'Zone not found or no price list configured: ' + zoneID
          : 'ZIP code not found in any service zone: ' + zipCode,
      }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const firstItem = allItems[0];
    const priceListID = firstItem.priceListID;
    // Prefer the franchise-friendly display name from /resources/priceLists/
    // (e.g. "Junk Removal - Regular PL"). Fall back to the template-style name
    // in firstItem.priceList if the names catalog didn't return a match.
    const nameMatch = priceListNames.find((p) => p.priceListID === priceListID);
    const priceListName = nameMatch?.priceList || firstItem.priceList || '';
    // Derive a friendlier zone name by stripping the Junkluggers-style prefix/suffix
    const zoneName = priceListName
      .replace(/^Junk Removal\s*-\s*/i, '')
      .replace(/\s*PL\s*$/i, '')
      .trim();

    // 5) Group items into blocks, filter excluded blocks and inactive items
    const blockMap: Record<number, { priceBlockID: number; name: string; sequence: number; items: Array<{ priceItemID: number; name: string; value: number; unitOfMeasure: string; sequence: number }> }> = {};
    for (const item of allItems) {
      if (!item.isActive) continue;
      if (EXCLUDED_BLOCK_IDS.includes(item.priceBlockID)) continue;
      if (!blockMap[item.priceBlockID]) {
        blockMap[item.priceBlockID] = {
          priceBlockID: item.priceBlockID,
          name: item.priceBlock,
          sequence: item.priceBlockSequence,
          items: [],
        };
      }
      blockMap[item.priceBlockID].items.push({
        priceItemID: item.priceItemID,
        name: item.priceItem,
        value: item.value,
        unitOfMeasure: item.unitOfMeasure,
        sequence: item.sequence,
      });
    }
    const blocks = Object.values(blockMap)
      .sort((a, b) => a.sequence - b.sequence)
      .map((block) => ({
        ...block,
        items: block.items.sort((a, b) => a.sequence - b.sequence),
      }));

    return new Response(JSON.stringify({
      success: true,
      zipCode: zipCode || '',
      zoneID: zoneID || '',
      priceListID,
      priceListName,
      zoneName,
      blocks,
    }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });

  } catch (e) {
    const err = e as Error;
    return new Response(JSON.stringify({
      success: false,
      error: 'Unhandled error: ' + (err.message || String(e)),
    }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});