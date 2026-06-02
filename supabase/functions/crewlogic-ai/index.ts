// Supabase Edge Function: crewlogic-ai (v4.1)
// Generic AI/utility router for CrewLogic backend calls
// Deploy: supabase functions deploy crewlogic-ai
//
// Actions:
//   analyzeEstimate    — voice transcript + optional photos → charge array (Anthropic)
//   generateJobSummary — charge list → customer items + crew ops summary (Anthropic)
//   classifyProperty   — street view photo → { dwellingType, parkingType } (Anthropic)
//   detectYardSign     — single photo → boolean detected + reasoning (Anthropic)
//   reverseGeocode     — lat/lng → formatted address (Google Geocoding)
//   issueReward        — deliver a sign_rewards row via PromoVault Quick Send
//
// v4.0: analyzeEstimate accepts truckCY (per-franchise truck size, default 16) and
//       sizes the full-truck volume reference at truckCY × 27 cf. Previously fixed at
//       480 cf (~17.8 CY), larger than the 16 CY billed, which under-estimated every
//       volume fraction by ~10%. Now AI volume math matches the app's truck size.
// v3.9: analyzeEstimate now fetches photo URLs server-side and forwards them
//       to Anthropic as base64, instead of passing the URL for Anthropic to
//       fetch (which failed intermittently on expired/unreachable Supabase
//       signed URLs). Also: better error logging — Anthropic failures log
//       status + request-id to function logs (concise message to client),
//       per-photo fetch errors are collected, and each request carries a
//       short reqId returned to the client for support correlation.
// v3.8: generateJobSummary now accepts franchiseInternalID and queries the
//       franchise's specialty tools to feed into the prompt. AI references
//       tools BY NAME in customerSituation (e.g., "bring Big Red for the
//       freezer"). Falls back gracefully when no franchise ID provided or
//       tools fetch fails. customerSituation length raised to 500 chars to
//       accommodate tool callouts.
//
// v3.1: Fixed handleAnalyzeEstimate JSON parser to extract array even when
//       Claude includes preamble text before the JSON.
// v3.2: Added customer-facing language guidelines to estimate system prompt
//       to keep descriptions neutral and professional (no "hoarder", etc.)
// v3.3: Fixed handleGenerateJobSummary — strip markdown fences before parse,
//       added customer-friendly language guidelines.
// v3.4: Tightened generateJobSummary — both itemsList and customerSituation
//       now limited to 2-3 sentence summaries (under ~300 chars each).
//       Reverted maxTokens to 600 since outputs are intentionally short.
// v3.5: Fixed dwellingType inference — system prompt now explicitly defines
//       when and how to return dwellingType, with strong default to
//       'private_home' when there's no clear visual evidence otherwise.
//       Previously, no instruction existed and Claude was returning
//       'apartment' by default due to training-data bias.
// v3.6: Added parkingType inference (driveway / street_parking / parking_lot /
//       front_curb / service_entrance / behind_building) with same opt-in
//       convention as dwellingType. Frontend reads charge._parkingType and
//       maps to Vonigo optionIDs (11227-11231, 19072). When omitted, falls
//       through to the dwellingType-derived default.
// v3.7: Added classifyProperty action — dedicated street-view classifier
//       that returns BOTH dwellingType and parkingType from the property's
//       exterior photo. Frontend uses this preferentially over per-charge
//       inference, since exterior view has the architectural cues that
//       interior/item photos lack.
//
// SECRETS REQUIRED (Supabase Dashboard → Edge Functions → crewlogic-ai → Secrets):
//   ANTHROPIC_API_KEY            — for Anthropic API calls
//   GOOGLE_GEOCODING_API_KEY     — Google Cloud key with Geocoding API enabled, NO referrer restriction
//   PROMOVAULT_API_KEY           — Master PromoVault token (multi-team scope)
//   SUPABASE_URL                 — auto-populated by Supabase
//   SUPABASE_SERVICE_ROLE_KEY    — auto-populated by Supabase, used for issueReward DB updates
//
// IMPORTANT: This is the COMPLETE source. Replace your entire crewlogic-ai
// edge function with this file's contents.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Base64-encode raw bytes in chunks. Encoding a large image in one
// String.fromCharCode(...bytes) call overflows the call stack, so we walk
// the buffer in 32KB slices.
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ════════════════════════════════════════════════════════════════════════════
// SHARED HELPER — calls Anthropic API
// ════════════════════════════════════════════════════════════════════════════
async function callAnthropic({
  system,
  userContent,
  maxTokens = 500,
  model = MODEL,
  label = 'request',
}: {
  system: string;
  userContent: unknown;
  maxTokens?: number;
  model?: string;
  label?: string;
}): Promise<Record<string, unknown>> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }]
    })
  });

  if (!res.ok) {
    const bodyText = await res.text();
    const anthropicReqId = res.headers.get('request-id') || 'n/a';
    // Full detail to the function logs; concise message to the client.
    console.error(`[${label}] Anthropic ${res.status} (request-id: ${anthropicReqId}): ${bodyText}`);
    throw new Error(`AI request failed (Anthropic ${res.status})`);
  }

  const result = await res.json() as Record<string, unknown>;

  if (result && (result.error || result.type === 'error')) {
    const err = result.error as Record<string, unknown> | undefined;
    throw new Error((err?.message as string) || 'Anthropic returned an error');
  }

  return result;
}

// ════════════════════════════════════════════════════════════════════════════
// HANDLER: analyzeEstimate
// Voice transcript + optional photos → charge array
// ════════════════════════════════════════════════════════════════════════════
function buildEstimateSystemPrompt(areas: string[], truckCY = 16): string {
  const cap = (truckCY && truckCY > 0) ? truckCY : 16;
  // Full-truck volume for the AI's fraction math = the franchise's ACTUAL truck (cubic
  // yards × 27 cf/yd). Previously fixed at 480 cf (~17.8 CY) — larger than the 16 CY the
  // app bills against — which made the AI under-estimate every fraction by ~10%. Now the
  // AI, pricing, CY displays, and storage tools all use ONE truck volume (truckCY).
  const refCFt = Math.round(cap * 27);
  const refCY = cap.toFixed(1);
  return `You are helping a junk removal estimator. A full truck holds ${refCFt} cubic feet, which is about ${refCY} cubic yards.
Volume fractions: Included (0), Minimum (0.0625), 1/8 (0.125), 1/4 (0.25), 3/8 (0.375), 1/2 (0.5), 5/8 (0.625), 3/4 (0.75), 7/8 (0.875), Full (1.0).
truckLabel is the fraction size of ONE truck. truckQty is how many of that fraction size. truckVolume = truckLabel value x truckQty.
For loads over 1 truck, ALWAYS use truckLabel "Full" and set truckQty to the total number of trucks as a decimal rounded to nearest 0.125. NEVER split into multiple charge rows.
Examples: 1.39 trucks: truckLabel "Full", truckQty 1.375, truckVolume 1.375. 0.6 trucks: truckLabel "1/2", truckQty 1, truckVolume 0.5.
Available areas: ${areas.join(', ')}.

CUSTOMER-FACING LANGUAGE — descriptions appear on customer estimates, so use neutral, professional, respectful language:
- NEVER use: "hoarder", "hoarding", "hoarder house/room", "cluttered mess", "filthy", "disgusting", "trashed", "wreck", "disaster", "pigsty", "junk pile", "garbage" (as descriptor for the customer's belongings), "crap", "stuff" (vague/dismissive), "useless", "worthless"
- INSTEAD use neutral terms: "densely packed", "fully packed", "heavily filled", "dense accumulation of items", "high volume of household items", "mixed household goods", "stored items", "accumulated belongings"
- For containers: "boxes and bins" not "junk boxes". For furniture: "household furniture" not "old/broken furniture" unless the condition is genuinely relevant for pricing
- Describe items factually by type and quantity (e.g., "12 boxes, 3 chairs, miscellaneous household items") without judgmental adjectives about condition or the customer
- Reasoning field is internal-only (not shown to customer) — but still keep it professional

DIMENSIONAL CALCULATIONS - when explicit measurements are given, always calculate precisely:
- Rectangular space: (L ft x W ft x H ft x fill%) / ${refCFt} = truck fraction
- Individual furniture/appliance: (L ft x W ft x H ft) / ${refCFt} = truck fraction. Use the FULL bounding-box volume. Do NOT apply a packing-reduction factor to standalone furniture — bulky rigid items (sofas, recliners, dressers, mattresses, appliances) do not nest and the crew cannot reclaim the empty space around them.
- Pile/group of small loose items (bags, boxes, toys, clothing) that genuinely compress: you may apply a 0.6 packing factor to the enclosing volume.
- Fill defaults: empty=5%, quarter=25%, half=50%, three-quarters=75%, packed=100%
- Convert inches to feet before calculating

ESTIMATING FURNITURE FROM PHOTOS (no measurements given):
When you cannot measure but can see furniture, anchor each visible item to these typical volumes, then SUM them. These reflect full bounding-box volume (the same basis the estimator's manual calculator uses):
  Item                            Truck %   Cubic ft   Cubic yd
  Sofa / 3-seat couch             ~14%      ~65        ~2.4
  Loveseat / 2-seat               ~9%       ~45        ~1.7
  Sectional sofa                  27-38%    130-180    ~5-7
  Recliner / armchair             ~7%       ~35        ~1.3
  Dresser / chest of drawers      ~6%       ~28        ~1.0
  Mattress + box (queen/king)     ~10%      ~50        ~1.9   (also add Mattress/Box Spring surcharge)
  Dining table                    ~9%       ~45        ~1.7
  Dining chair (each)             ~1.5%     ~7         ~0.3
  Desk                            ~6%       ~31        ~1.1
  Bookcase / armoire / wardrobe   ~8%       ~40        ~1.5
  Refrigerator / large appliance  ~10%      ~48        ~1.8
  Washer or dryer (each)          ~3.5%     ~17        ~0.6
  Patio / outdoor set             ~19%      ~90        ~3.3
The Truck % column is approximate — always compute truck % as (item cubic ft / full-truck cubic ft) using the full-truck volume stated at the top. The cubic-ft and cubic-yd anchors are physical measurements and do not change with truck size.
When furniture is involved, estimate slightly HIGH rather than low — an under-filled truck means a costly return trip.

CONFIDENCE & ROUNDING:
- If items are partially hidden, stacked, or the photo angle obscures depth, assume MORE volume than the visible face suggests and set confidence to "low" or "medium".
- For furniture-heavy loads, round the final truckVolume UP to the nearest standard fraction when between two values.

DWELLING TYPE INFERENCE — IMPORTANT:
When you see photos, you may add a "dwellingType" field to the FIRST charge object in your response array if (and ONLY if) the photo shows strong visual evidence of the property type. The valid values are:
  "private_home"      — single-family house, townhouse, detached or row home (driveway, yard, garage, exterior siding visible, residential street, etc.)
  "condominium"       — condo unit (visible building common area, condo signage, condo-style multi-unit building, etc.)
  "apartment"         — apartment unit (visible hallway with multiple doors, fire escape, balcony in multi-story building, apartment complex parking lot, intercom panel, etc.)
  "storage_unit"      — self-storage facility (roll-up door, numbered unit, storage facility hallway, etc.)
  "office"            — commercial office space (cubicles, conference room, office building, etc.)
  "retail_location"   — retail or commercial business (storefront, shop floor, retail signage, etc.)
  "assisted_living"   — assisted living facility (visible signage, communal areas, etc.)

DEFAULT RULE — when in doubt, OMIT the dwellingType field entirely. The system defaults to "private_home" when no dwellingType is provided. Most junk removal customers are homeowners; do NOT guess "apartment" just because the photo is indoors.

DO NOT return dwellingType if:
- The photo is purely interior (a room, a pile of items, a closet) with no architectural cues
- The photo shows only items being removed with no context about the building
- The property type is ambiguous
- You're inferring from training-data patterns rather than visual evidence

Sheds, garages, yards, driveways, and detached structures are strong signals for "private_home" — return that explicitly when you see them.

PARKING TYPE INFERENCE — same opt-in approach as dwellingType:
When you see photos that show clear visual evidence of where the crew will park, you may add a "parkingType" field to the FIRST charge object. The valid values are:
  "driveway"          — visible residential driveway, paved or unpaved pull-in beside or in front of a home
  "street_parking"    — residential street with curbside parking only, no visible driveway, urban row houses, parked cars along the curb
  "parking_lot"       — commercial parking lot, apartment complex lot, condo lot, store/office lot
  "front_curb"        — items already at the front curb ready for pickup (curbside pile-out, town transfer station drop, etc.)
  "service_entrance"  — loading dock, service entrance, back-of-building service door (commercial settings)
  "behind_building"   — back alley, behind-building access lane, alleyway entry

DEFAULT RULE for parking — when in doubt, OMIT the parkingType field. The frontend will derive a sensible default (driveway for homes, parking lot for everything else). Most residential jobs use the driveway; do NOT guess "street_parking" just because urban-looking photos show cars on a street.

DO NOT return parkingType if:
- The photo is interior-only with no view of the building exterior or street
- The photo shows only items being removed, no parking/access context
- The parking situation is ambiguous

Return ONLY a JSON array, no markdown. Always start with a volume charge, then surcharges for recyclables.
Volume charge format:
{"type":"volume","room":"name","area":"from list","description":"items","notIncluded":"","truckLabel":"1/2","truckQty":1,"truckVolume":0.5,"confidence":"low|medium|high","reasoning":"one sentence","dwellingType":"private_home","parkingType":"driveway"}
(BOTH dwellingType and parkingType are OPTIONAL — only include them on the first charge object, and only when you have strong visual evidence per the rules above.)
Surcharge format (exact names only):
{"type":"surcharge","name":"TV/Monitor(s)","qty":1,"area":"from list","description":""}
Exact surcharge names:
- Mattress/Box Spring(s)
- TV/Monitor(s)
- Electronic Waste
- Freon Appliance(s)
- Tire(s)
- Paint Can(s)
- Shredding`;
}

async function handleAnalyzeEstimate(payload: Record<string, unknown>): Promise<unknown> {
  const transcript = payload.transcript as string | undefined;
  const areas = (payload.areas as string[]) || [];
  const photos = (payload.photos as string[]) || [];
  const truckCY = Number(payload.truckCY) || 16;   // per-franchise truck size; default 16 CY

  if (!transcript && photos.length === 0) {
    throw new Error('transcript or photos required');
  }

  let userContent: unknown;

  if (photos.length > 0) {
    const imageContents: unknown[] = [];
    const photoErrors: string[] = [];

    for (const photo of photos) {
      try {
        if (photo.startsWith('data:image')) {
          const base64 = photo.replace(/^data:image\/\w+;base64,/, '');
          if (base64.length > 100) {
            const mt = photo.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
            imageContents.push({
              type: 'image',
              source: { type: 'base64', media_type: mt, data: base64 }
            });
          } else {
            photoErrors.push('data-url too small');
          }
        } else {
          // Resolve legacy Google Drive refs, then fetch the image OURSELVES and
          // forward it as base64. Previously we passed the URL to Anthropic and
          // let it fetch — fragile when a Supabase signed URL is expired or
          // momentarily unreachable from Anthropic's network. Fetching here (in
          // Supabase's own network) and sending bytes is far more reliable.
          const m = photo.match(/[?&]id=([^&]+)/);
          const imageUrl = m
            ? `https://lh3.googleusercontent.com/d/${m[1]}=s1600`
            : photo;
          const imgRes = await fetch(imageUrl);
          if (!imgRes.ok) {
            console.warn(`[analyzeEstimate] image fetch ${imgRes.status}: ${imageUrl.slice(0, 120)}`);
            photoErrors.push(`fetch ${imgRes.status}`);
            continue;
          }
          const ct = imgRes.headers.get('content-type') || '';
          const mediaType = ct.startsWith('image/') ? ct.split(';')[0].trim() : 'image/jpeg';
          const bytes = new Uint8Array(await imgRes.arrayBuffer());
          imageContents.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: uint8ToBase64(bytes) }
          });
        }
      } catch (e) {
        console.warn('[analyzeEstimate] photo processing failed:', e);
        photoErrors.push((e as Error).message || 'unknown error');
      }
    }

    if (imageContents.length === 0) {
      throw new Error(`All photos failed to load${photoErrors.length ? ': ' + photoErrors.join('; ') : ''}`);
    }

    const multiNote = imageContents.length > 1
      ? `There are ${imageContents.length} photos of the same room. Do NOT double-count items that appear in multiple photos.`
      : '';

    userContent = [
      ...imageContents,
      {
        type: 'text',
        text: `${transcript || '[PHOTO ANALYSIS — analyze visible items and estimate volume]'}\n${multiNote}\nAnalyze the photo(s) and identify all visible items. Estimate volume and return the JSON array as instructed. Leave room name blank ("") if not identifiable from the photo.`
      }
    ];
  } else {
    userContent = transcript;
  }

  const result = await callAnthropic({
    system: buildEstimateSystemPrompt(areas, truckCY),
    userContent,
    // v4.1: bumped 800 -> 4096. Content-heavy rooms (e.g. a packed basement) produce a
    // charge array longer than 800 output tokens; the response was being truncated mid-JSON,
    // the bracket-matcher found no closing ']', JSON.parse threw, and the UI showed
    // "Analysis failed — please try again". 4096 gives ample headroom for large estimates.
    maxTokens: 4096,
    label: 'analyzeEstimate',
  });

  const content = result.content as Array<{ type: string; text: string }> | undefined;
  const rawText = content?.[0]?.text || '[]';

  // Extract JSON from response. Claude may wrap in markdown fences AND/OR include
  // preamble text before the array (e.g. "I can see two photos showing... ```json [...]```")
  // Strategy: find the first '[' and its matching ']' — that's our array.
  let jsonText = rawText
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  // If the cleaned text doesn't START with '[' or '{', extract the first array we find.
  if (!jsonText.startsWith('[') && !jsonText.startsWith('{')) {
    const firstBracket = jsonText.indexOf('[');
    const firstBrace = jsonText.indexOf('{');
    let start = -1;
    if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
      start = firstBracket;
    } else if (firstBrace !== -1) {
      start = firstBrace;
    }
    if (start !== -1) {
      jsonText = jsonText.slice(start);
      // Trim trailing prose after the JSON ends
      // Walk forward tracking bracket depth to find the matching close
      const open = jsonText[0];
      const close = open === '[' ? ']' : '}';
      let depth = 0;
      let inString = false;
      let escape = false;
      let endIdx = -1;
      for (let i = 0; i < jsonText.length; i++) {
        const ch = jsonText[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) { endIdx = i; break; }
        }
      }
      if (endIdx !== -1) jsonText = jsonText.slice(0, endIdx + 1);
    }
  }

  let charges: unknown[];
  try {
    const parsed = JSON.parse(jsonText);
    charges = Array.isArray(parsed) ? parsed : [parsed];
  } catch (_e) {
    console.error('Failed to parse Claude response:', rawText);
    throw new Error('Claude returned invalid JSON');
  }

  return { charges };
}


// ════════════════════════════════════════════════════════════════════════════
// HANDLER: generateJobSummary
// Charge list → customer items + crew ops summary
//
// When franchiseInternalID is provided, also fetches the franchise's active
// specialty tools (not always-on-truck) and includes them in the prompt so
// the customer-situation field can reference tools BY NAME (e.g. "bring Big
// Red for the freezer"). Falls back to tool-agnostic output if no franchise
// ID provided or if the tools fetch fails.
// ════════════════════════════════════════════════════════════════════════════
async function handleGenerateJobSummary(payload: Record<string, unknown>): Promise<unknown> {
  const charges = payload.charges as Array<Record<string, unknown>> || [];
  const notes = (payload.notes as string) || '';
  const franchiseInternalID = (payload.franchiseInternalID as string) || '';

  const volumeDescriptions = charges
    .filter(c => c.type === 'volume')
    .map(c => {
      const parts: string[] = [];
      if (c.room) parts.push(String(c.room));
      if (c.area) parts.push('(' + String(c.area) + ')');
      if (c.description) parts.push(': ' + String(c.description));
      if (c.notIncluded) parts.push('[NOT included: ' + String(c.notIncluded) + ']');
      return parts.join(' ');
    })
    .filter(Boolean)
    .join('\n');

  const surcharges = charges
    .filter(c => c.type === 'surcharge')
    .map(c => String(c.name) + (c.qty && c.qty !== 1 ? ' x' + c.qty : ''))
    .join(', ');

  // Fetch this franchise's specialty tools (load-as-needed only — the AI
  // doesn't need to mention always-on-truck items like Dolly or Dust Pan).
  // Non-fatal if it fails — we still produce a summary, just without tool refs.
  let toolsBlock = '';
  if (franchiseInternalID) {
    try {
      const tools = await supabaseGet(
        '/rest/v1/tools?franchise_id=eq.' + encodeURIComponent(franchiseInternalID) +
        '&is_active=eq.true&is_on_truck=eq.false' +
        '&select=name,description,use_case' +
        '&order=name.asc'
      ) as Array<Record<string, unknown>>;
      if (tools && tools.length > 0) {
        const lines = tools.map(t => {
          const name = String(t.name || '');
          const useCase = String(t.use_case || t.description || '');
          return '  - ' + name + (useCase ? ' — ' + useCase : '');
        });
        toolsBlock =
          '\n\nSPECIALTY TOOLS available at this franchise (each is a SINGLE physical item):\n' +
          lines.join('\n') +
          '\n\nWhen the job description suggests a stop needs one of these tools, mention it BY NAME ' +
          'in customerSituation (e.g., "bring Big Red for the freezer"). Match tools to specific items, ' +
          'not job size. Do NOT mention always-on-truck items (regular dollies, hand trucks, gloves, ' +
          'brooms, masks, knives, etc) — those are implicit.';
      }
    } catch (e) {
      console.warn('[generateJobSummary] tools fetch failed (non-fatal):', (e as Error).message);
    }
  }

  const system = `You generate two BRIEF outputs for a junk removal job:
1. itemsList — 2-3 sentence customer-facing summary of items being removed. Customer will see this on their estimate. AVOID judgmental words like "hoarder", "cluttered", "filthy", "trashed", "junk pile", "garbage", "crap", "stuff", "useless". Use neutral terms: "household items", "boxes and bins", "stored items", "household furniture", "accumulated belongings". Group by general category, don't list every single item.
2. customerSituation — crew-facing ops summary (NOT shown to customer). Hit only the key safety/lift/access points the crew needs to know. Skip obvious things. When tools are listed below, reference them BY NAME when relevant.

itemsList must stay short (under 300 chars, 2-3 sentences).
customerSituation can be up to 500 chars / 4 sentences if it needs to call out specific tools and access concerns. Be operational, not chatty.${toolsBlock}

Respond ONLY with a JSON object, no markdown fences, no preamble:
{"itemsList": "...", "customerSituation": "..."}`;

  const userMessage = `Charges:\n${volumeDescriptions}${surcharges ? '\n\nSpecial items: ' + surcharges : ''}${notes ? '\n\nAccess notes: ' + notes : ''}`;

  const result = await callAnthropic({
    system,
    userContent: userMessage,
    maxTokens: 800,
  });

  const content = result.content as Array<{ type: string; text: string }> | undefined;
  const rawText = content?.[0]?.text || '{}';

  let parsed: Record<string, string>;
  try {
    // Strip markdown fences if Claude included them despite the prompt
    let cleaned = rawText
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();
    // Try direct parse first; fall back to extracting first {...} block
    try {
      parsed = JSON.parse(cleaned);
    } catch (_inner) {
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
    }
  } catch (_e) {
    console.error('Failed to parse generateJobSummary response:', rawText);
    parsed = { itemsList: '', customerSituation: '' };
  }

  return {
    itemsList: parsed.itemsList || '',
    customerSituation: parsed.customerSituation || '',
  };
}


// ════════════════════════════════════════════════════════════════════════════
// HANDLER: classifyProperty
// Street view photo → { dwellingType, parkingType } based on exterior cues
// ════════════════════════════════════════════════════════════════════════════
async function handleClassifyProperty(payload: Record<string, unknown>): Promise<unknown> {
  const photo = payload.photo as string;
  if (!photo) {
    return { dwellingType: null, parkingType: null, reasoning: 'No photo provided' };
  }

  const system = `You are looking at a Google Street View photo of a property where a junk removal job will take place. Your job is to classify two things based on what you SEE in the exterior view:

1. dwellingType — what kind of building/property is this?
   "private_home"      — single-family house, townhouse, detached or row home (residential exterior, driveway, yard, front porch, garage, residential street)
   "condominium"       — condo unit in a multi-unit residential building with shared common areas
   "apartment"         — apartment building (multi-story, multiple units, apartment complex layout, fire escapes, balconies)
   "storage_unit"      — self-storage facility (roll-up doors, numbered units, fencing, gates)
   "office"            — commercial office building (glass facade, business signage, professional plaza)
   "retail_location"   — retail business or storefront (shop signage, customer entrance, commercial strip)
   "assisted_living"   — assisted living facility (institutional signage, large residential-care complex)

2. parkingType — where would the crew most likely park to do this job?
   "driveway"          — visible driveway leading to the home (most residential homes)
   "street_parking"    — no visible driveway, residential street with curb parking only (urban row houses, dense residential)
   "parking_lot"       — commercial or multi-unit parking lot is the obvious access point
   "front_curb"        — pile-out at the front curb is the natural staging area
   "service_entrance"  — clear loading dock or service entrance visible (commercial)
   "behind_building"   — back alley access is the natural approach (urban commercial)

If you cannot reasonably determine a value with confidence, return null for that field. The frontend will fall back to sensible defaults (private_home / driveway).

Respond ONLY with a JSON object in this exact format (no markdown, no preamble):
{"dwellingType": "<value or null>", "parkingType": "<value or null>", "reasoning": "<one short sentence>"}`;

  // Build image content block
  let imageBlock: Record<string, unknown>;
  if (photo.startsWith('data:image/')) {
    const match = photo.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) {
      return { dwellingType: null, parkingType: null, reasoning: 'Invalid base64 photo format' };
    }
    imageBlock = {
      type: 'image',
      source: { type: 'base64', media_type: match[1], data: match[2] }
    };
  } else if (photo.startsWith('http')) {
    imageBlock = {
      type: 'image',
      source: { type: 'url', url: photo }
    };
  } else {
    return { dwellingType: null, parkingType: null, reasoning: 'Photo must be a base64 data URL or https URL' };
  }

  const userContent = [
    imageBlock,
    { type: 'text', text: 'Classify the dwelling type and parking type for this property. Respond with JSON only.' }
  ];

  let result: Record<string, unknown>;
  try {
    result = await callAnthropic({
      system,
      userContent,
      maxTokens: 200,
    });
  } catch (e) {
    const err = e as Error;
    return {
      dwellingType: null,
      parkingType: null,
      reasoning: 'Anthropic call failed: ' + (err.message || String(e)),
    };
  }

  const content = result.content as Array<{ type: string; text: string }> | undefined;
  const rawText = content?.[0]?.text || '';
  if (!rawText) {
    return { dwellingType: null, parkingType: null, reasoning: 'Empty response' };
  }

  let parsed: { dwellingType?: string | null; parkingType?: string | null; reasoning?: string };
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
  } catch (_e) {
    return {
      dwellingType: null,
      parkingType: null,
      reasoning: 'Parse failed: ' + rawText.slice(0, 200),
    };
  }

  // Validate values against the allowed set
  const validDwellings = ['private_home', 'condominium', 'apartment', 'storage_unit', 'office', 'retail_location', 'assisted_living'];
  const validParking = ['driveway', 'street_parking', 'parking_lot', 'front_curb', 'service_entrance', 'behind_building'];

  return {
    dwellingType: parsed.dwellingType && validDwellings.includes(parsed.dwellingType) ? parsed.dwellingType : null,
    parkingType: parsed.parkingType && validParking.includes(parsed.parkingType) ? parsed.parkingType : null,
    reasoning: parsed.reasoning || '',
  };
}


// ════════════════════════════════════════════════════════════════════════════
// HANDLER: detectYardSign  (NEW)
// Single photo → boolean detected + reasoning
// ════════════════════════════════════════════════════════════════════════════
async function handleDetectYardSign(payload: Record<string, unknown>): Promise<unknown> {
  const photo = payload.photo as string;
  if (!photo) {
    return { detected: null, confidence: 'low', reasoning: 'No photo provided.' };
  }

  const system = `You are an image classifier verifying yard sign placements for a junk removal company's marketing program. Your job is to look at one photo and determine whether it shows a yard sign that has been placed in the ground.

A "yard sign" is:
- A small standing sign (typically 18"x24" or similar), usually attached to wire stakes or a metal H-frame stand
- Pushed into the ground (lawn, grass, dirt, mulch, roadside, etc.)
- Has visible text, a logo, or branding on it
- Examples include: real estate signs, political signs, junk removal signs, business advertising signs, yard sale signs, contractor signs

A yard sign is NOT:
- Trees, plants, flowers, mailboxes, fence posts, utility poles, or any natural/structural element
- A photo of grass, sky, dashboard, ceiling, hands, or random scenes
- Signs mounted permanently to buildings, billboards, or large highway signs
- A blurry photo where no sign is identifiable

Respond ONLY with a JSON object in this exact format (no other text, no markdown, no preamble):
{"detected": <true|false>, "confidence": "<high|medium|low>", "reasoning": "<one short sentence explaining what you see>"}

Be lenient on partial views — if you can see ANY portion of a yard sign in the ground (even an edge or back), set detected=true. Be strict against false positives — if the photo shows no recognizable yard sign, set detected=false.`;

  // Build the image content block
  let imageBlock: Record<string, unknown>;
  if (photo.startsWith('data:image/')) {
    const match = photo.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) {
      return { detected: null, confidence: 'low', reasoning: 'Invalid base64 photo format.' };
    }
    imageBlock = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: match[1],
        data: match[2],
      }
    };
  } else if (photo.startsWith('http')) {
    imageBlock = {
      type: 'image',
      source: { type: 'url', url: photo }
    };
  } else {
    return { detected: null, confidence: 'low', reasoning: 'Photo must be a base64 data URL or https URL.' };
  }

  const userContent = [
    imageBlock,
    { type: 'text', text: 'Is there a yard sign visible in this photo? Respond with the JSON format only.' }
  ];

  let result: Record<string, unknown>;
  try {
    result = await callAnthropic({
      system,
      userContent,
      maxTokens: 200,
    });
  } catch (e) {
    const err = e as Error;
    return {
      detected: null,
      confidence: 'low',
      reasoning: 'Anthropic call failed: ' + (err.message || String(e)),
    };
  }

  const content = result.content as Array<{ type: string; text: string }> | undefined;
  const rawText = content?.[0]?.text || '';
  if (!rawText) {
    return {
      detected: null,
      confidence: 'low',
      reasoning: 'Anthropic returned empty content.',
    };
  }

  let parsed: { detected?: boolean; confidence?: string; reasoning?: string };
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
  } catch (_e) {
    return {
      detected: null,
      confidence: 'low',
      reasoning: 'Could not parse AI response: ' + rawText.slice(0, 200),
    };
  }

  return {
    detected: typeof parsed.detected === 'boolean' ? parsed.detected : null,
    confidence: parsed.confidence || 'medium',
    reasoning: parsed.reasoning || '',
  };
}


// ════════════════════════════════════════════════════════════════════════════
// HANDLER: reverseGeocode  (NEW)
// lat/lng → Google Geocoding API → formatted address
// ════════════════════════════════════════════════════════════════════════════
async function handleReverseGeocode(payload: Record<string, unknown>): Promise<unknown> {
  const lat = parseFloat(payload.lat as string);
  const lng = parseFloat(payload.lng as string);

  if (!isFinite(lat) || !isFinite(lng)) {
    return { address: '', error: 'Invalid lat/lng' };
  }

  const apiKey = Deno.env.get('GOOGLE_GEOCODING_API_KEY');
  if (!apiKey) {
    return { address: '', error: 'GOOGLE_GEOCODING_API_KEY not configured' };
  }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;

  // 10 second timeout
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!res.ok) {
      return { address: '', error: `Geocoding API ${res.status}` };
    }

    const data = await res.json() as {
      status?: string;
      error_message?: string;
      results?: Array<{ formatted_address?: string }>;
    };

    if (data.status !== 'OK') {
      return {
        address: '',
        error: `${data.status || 'unknown'}: ${data.error_message || ''}`.trim(),
      };
    }

    const address = data.results?.[0]?.formatted_address || '';
    return { address };

  } catch (e) {
    clearTimeout(timer);
    const err = e as Error;
    return {
      address: '',
      error: err.name === 'AbortError' ? 'Geocoding timed out (10s)' : `Network error: ${err.message}`,
    };
  }
}


// ════════════════════════════════════════════════════════════════════════════
// HANDLER: issueReward  (NEW)
// Deliver a sign_rewards row via PromoVault Quick Send
// ════════════════════════════════════════════════════════════════════════════
const PROMOVAULT_BASE = 'https://api3.promotionvault.com';

// Read a row from Supabase using the service role key (bypasses RLS).
async function supabaseGet(path: string): Promise<unknown> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const res = await fetch(supabaseUrl + path, {
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
  });
  if (!res.ok) throw new Error('Supabase GET ' + path + ' failed: ' + res.status);
  return res.json();
}

// Patch a row using the service role key.
async function supabasePatch(path: string, body: Record<string, unknown>): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const res = await fetch(supabaseUrl + path, {
    method: 'PATCH',
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Supabase PATCH ' + path + ' failed: ' + res.status + ' ' + text);
  }
}

async function handleIssueReward(payload: Record<string, unknown>): Promise<unknown> {
  const rewardId = payload.rewardId as string;
  if (!rewardId) {
    return { success: false, error: 'rewardId required' };
  }

  // 1. Load the reward row + its crew member
  const rewardRows = await supabaseGet(
    '/rest/v1/sign_rewards?id=eq.' + encodeURIComponent(rewardId) +
    '&select=id,franchise_id,crew_member_id,reward_amount_dollars,status'
  ) as Array<Record<string, unknown>>;
  if (!rewardRows || !rewardRows.length) {
    return { success: false, error: 'Reward not found' };
  }
  const reward = rewardRows[0];

  // Idempotency — don't re-deliver an already-delivered reward
  if (reward.status === 'issued' || reward.status === 'test') {
    return { success: true, alreadyDelivered: true, rewardId };
  }

  // 2. Load the crew member (recipient)
  const crewRows = await supabaseGet(
    '/rest/v1/crew_members?id=eq.' + encodeURIComponent(reward.crew_member_id as string) +
    '&select=first_name,last_name,email,phone'
  ) as Array<Record<string, unknown>>;
  if (!crewRows || !crewRows.length) {
    await supabasePatch('/rest/v1/sign_rewards?id=eq.' + encodeURIComponent(rewardId), {
      status: 'failed',
      error_message: 'Crew member not found',
    });
    return { success: false, error: 'Crew member not found' };
  }
  const crew = crewRows[0];

  // 3. Load the franchise's PromoVault config
  const franchiseRows = await supabaseGet(
    '/rest/v1/franchises?id=eq.' + encodeURIComponent(reward.franchise_id as string) +
    '&select=cost_settings'
  ) as Array<Record<string, unknown>>;
  if (!franchiseRows || !franchiseRows.length) {
    await supabasePatch('/rest/v1/sign_rewards?id=eq.' + encodeURIComponent(rewardId), {
      status: 'failed',
      error_message: 'Franchise not found',
    });
    return { success: false, error: 'Franchise not found' };
  }
  const costSettings = (franchiseRows[0].cost_settings as Record<string, unknown>) || {};
  const signsCfg = (costSettings.signs as Record<string, unknown>) || {};
  const teamId = signsCfg.promoVaultTeamId as string | number | undefined;
  const testMode = signsCfg.signsTestMode !== false;  // defaults true

  if (!teamId) {
    await supabasePatch('/rest/v1/sign_rewards?id=eq.' + encodeURIComponent(rewardId), {
      status: 'failed',
      error_message: 'PromoVault Team ID not configured for this franchise',
    });
    return { success: false, error: 'PromoVault Team ID not configured' };
  }

  // 4. Test mode — fake the delivery, mark as test with a synthetic ID
  if (testMode) {
    const fakeId = 'TEST-' + Date.now();
    await supabasePatch('/rest/v1/sign_rewards?id=eq.' + encodeURIComponent(rewardId), {
      status: 'test',
      promovault_reward_id: fakeId,
      reward_link: 'TEST_MODE_NO_LINK',
      issued_at: new Date().toISOString(),
      promovault_request: { test_mode: true, note: 'No actual API call made' },
      promovault_response: { test_mode: true, fake_id: fakeId },
    });
    return { success: true, testMode: true, externalId: fakeId };
  }

  // 5. Live mode — call PromoVault Quick Send
  const apiKey = Deno.env.get('PROMOVAULT_API_KEY');
  if (!apiKey) {
    await supabasePatch('/rest/v1/sign_rewards?id=eq.' + encodeURIComponent(rewardId), {
      status: 'failed',
      error_message: 'PROMOVAULT_API_KEY not configured in Edge Function secrets',
    });
    return { success: false, error: 'PROMOVAULT_API_KEY not configured' };
  }

  const amountDollars = parseFloat(reward.reward_amount_dollars as string) || 0;
  const amountCents = Math.round(amountDollars * 100);
  const fullName = ((crew.first_name as string) || '') + ' ' + ((crew.last_name as string) || '');

  const requestBody: Record<string, unknown> = {
    team: teamId,
    amount: String(amountCents),
    name: fullName.trim() || 'Crew Member',
    requires_activation: 'false',
    send_activation: 'true',
    subject: 'Yard Sign Reward — $' + amountDollars,
    email_message: 'Thanks for placing yard signs! Click below to claim your $' + amountDollars + ' reward.',
    short_description: 'Yard sign placement reward — earned through CrewLogic',
    in_app_message: 'Great work! Keep placing signs to earn more.',
    tags: ['crewlogic'],
  };
  if (crew.email) requestBody.email = crew.email;
  if (crew.phone) requestBody.mobile = crew.phone;

  // Need at least email or mobile to deliver
  if (!crew.email && !crew.phone) {
    await supabasePatch('/rest/v1/sign_rewards?id=eq.' + encodeURIComponent(rewardId), {
      status: 'failed',
      error_message: 'Crew member has no email or mobile on file',
    });
    return { success: false, error: 'No email or mobile for crew member' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let pvData: Record<string, unknown>;
  try {
    const pvRes = await fetch(PROMOVAULT_BASE + '/quick-send/', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: 'token ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    clearTimeout(timer);
    if (!pvRes.ok) {
      const errText = await pvRes.text().catch(() => '');
      await supabasePatch('/rest/v1/sign_rewards?id=eq.' + encodeURIComponent(rewardId), {
        status: 'failed',
        error_message: 'PromoVault HTTP ' + pvRes.status + ': ' + errText.slice(0, 300),
      });
      return { success: false, error: 'PromoVault API ' + pvRes.status + ': ' + errText.slice(0, 200) };
    }
    pvData = await pvRes.json();
  } catch (e) {
    clearTimeout(timer);
    const err = e as Error;
    const msg = err.name === 'AbortError'
      ? 'PromoVault timed out (25s)'
      : 'Network error: ' + err.message;
    await supabasePatch('/rest/v1/sign_rewards?id=eq.' + encodeURIComponent(rewardId), {
      status: 'failed',
      error_message: msg,
    });
    return { success: false, error: msg };
  }

  // 6. Parse response, build reward link, save to DB (with full audit trail)
  const externalId = String(pvData.id || '');
  const directKey = pvData.direct_key as string | undefined;
  const directSecret = pvData.direct_secret as string | undefined;
  const code = pvData.code as string | undefined;
  const rewardLink = (directKey && directSecret && code)
    ? 'http://rewards.promotionvault.com/direct-link/' + directKey + '/' + directSecret + '/' + code + '/'
    : '';

  await supabasePatch('/rest/v1/sign_rewards?id=eq.' + encodeURIComponent(rewardId), {
    status: 'issued',
    promovault_reward_id: externalId,
    reward_link: rewardLink,
    issued_at: new Date().toISOString(),
    promovault_request: requestBody,
    promovault_response: pvData,
  });

  return {
    success: true,
    externalId,
    rewardLink,
    rewardId,
  };
}


// ════════════════════════════════════════════════════════════════════════════
// ACTION ROUTER
// ════════════════════════════════════════════════════════════════════════════
const ACTION_HANDLERS: Record<string, (payload: Record<string, unknown>) => Promise<unknown>> = {
  analyzeEstimate: handleAnalyzeEstimate,
  generateJobSummary: handleGenerateJobSummary,
  classifyProperty: handleClassifyProperty,
  detectYardSign: handleDetectYardSign,
  reverseGeocode: handleReverseGeocode,
  issueReward: handleIssueReward,
};


// ════════════════════════════════════════════════════════════════════════════
// MAIN SERVE
// ════════════════════════════════════════════════════════════════════════════
serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const reqId = crypto.randomUUID().slice(0, 8);
  let action: string | undefined;

  try {
    if (!ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }

    const body = await req.json() as Record<string, unknown>;
    action = body.action as string;

    if (!action) {
      return new Response(
        JSON.stringify({ success: false, error: 'action field required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const handler = ACTION_HANDLERS[action];
    if (!handler) {
      return new Response(
        JSON.stringify({ success: false, error: `Unknown action: ${action}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const result = await handler(body);

    return new Response(
      JSON.stringify({ success: true, ...(result as object) }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const err = error as Error;
    console.error(`[crewlogic-ai][${reqId}] action=${action ?? '?'} error:`, err?.stack || err?.message || err);
    return new Response(
      JSON.stringify({ success: false, error: err.message || String(error), reqId }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});