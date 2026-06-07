// Supabase Edge Function: crewlogic-job-plan (v1.12)
// v1.12: Removed "---" separators between routes — they clutter WhatsApp/Slack
//   pastes with line wrapping. Single blank line is enough.
// Generates an AI-written morning brief / job plan for a franchise's crew.
//
// For a given date (today, tomorrow, or day after) this:
//   1) Fetches all open WorkOrders for the franchise (including confidential
//      notes + item locations — same as the picker with includePlanData=true).
//   2) Queries Supabase for the franchise's tools list (always-on-truck vs
//      specialty tools that need to be loaded).
//   3) Groups WorkOrders by route and builds a structured prompt.
//   4) Calls Anthropic's Claude Sonnet to synthesize a concise, operational
//      plan per route. The AI is told to be brief, surface only what's
//      non-obvious, and call out which specialty tools to load.
//   5) Parses the AI response into per-route blocks and returns structured
//      JSON the frontend can render and let the user edit.
//
// Input:
//   { franchiseID: "90", dayOffset: 1 }     // 0 = today, 1 = tomorrow, 2 = day after
//
// Output:
//   {
//     success: true,
//     date: "2026-05-16",
//     totalJobs: 9,
//     routes: [
//       { routeName: "Route 1 (MA1REG)", stopCount: 2, plan: "...AI text..." },
//       ...
//     ],
//     meta: { model: "...", usage: { input_tokens, output_tokens } }
//   }
//
// Deploy: supabase functions deploy crewlogic-job-plan
// Requires Edge Function secret: ANTHROPIC_API_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TENANT_ID = '946a4535-aa61-45b6-a6fb-9190ff546d41'; // Junkluggers
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_MAX_TOKENS = 4000;
// Derive from the project's own URL so dev calls dev's functions (not prod's). Falls back
// to prod if SUPABASE_URL is somehow unset. (Prod behavior unchanged: SUPABASE_URL=prod there.)
const SUPABASE_URL_BASE = (Deno.env.get('SUPABASE_URL') || 'https://ozfkpxyachigfpcmvekz.supabase.co') + '/functions/v1';

interface WorkOrder {
  jobID: string;
  workOrderID: string;
  clientName: string;
  address: string;
  items: string;
  timeLabel: string;
  status: string;
  route: string;
  price: number;
  notes?: string;
  itemLocations?: string[];
}

interface Tool {
  name: string;
  category: string | null;
  description: string | null;
  use_case: string | null;
  is_on_truck: boolean;
}

// ---------------------------------------------------------------------------
// Anthropic API helper
// ---------------------------------------------------------------------------

async function callAnthropic(apiKey: string, prompt: string): Promise<{ text: string; usage: any }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Anthropic API error ' + res.status + ': ' + errText);
  }
  const data = await res.json();
  const text = (data.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
  return { text, usage: data.usage || {} };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(
  date: string,
  routesGrouped: Record<string, WorkOrder[]>,
  toolsOnTruck: Tool[],
  toolsSpecialty: Tool[],
): string {
  const lines: string[] = [];

  lines.push(`You write daily route plans for a junk removal franchise's ops manager.`);
  lines.push(`The ops manager will use your draft and add crew assignments, arrival times,`);
  lines.push(`and logistics details before sending to crews. Your job: produce a concise,`);
  lines.push(`scannable skeleton of facts the ops manager can build on.`);
  lines.push('');
  lines.push(`DATE: ${date}`);
  lines.push('');

  // Tools context — but only specialty tools matter; we don't list always-on-truck.
  // Skipped entirely when toolsSpecialty is empty (test mode or no tools configured).
  if (toolsSpecialty.length > 0) {
    lines.push(`SPECIALTY TOOLS (each is a SINGLE physical item — can only be on ONE route per day):`);
    for (const t of toolsSpecialty) {
      lines.push(`  - ${t.name}${t.use_case ? ' — ' + t.use_case : ''}`);
    }
    lines.push('');
    lines.push(`SPECIALTY TOOL ASSIGNMENT RULES:`);
    lines.push(`  - Each specialty tool listed above is 1-of-1 inventory. You cannot put the`);
    lines.push(`    same tool on multiple routes' Load lines.`);
    lines.push(`  - If two routes appear to need the same tool, assign it to the route where`);
    lines.push(`    it is MOST needed (the heaviest single item, the largest demo job, etc.).`);
    lines.push(`  - Match tools to the SPECIFIC item, not the size of the overall job.`);
    lines.push(`    A 3-truck cleanout with a washer does NOT need Big Red — a regular dolly`);
    lines.push(`    handles a washer. A piano-only pickup DOES need Big Red.`);
    lines.push(`  - When in doubt, omit the tool from Load — the standard kit covers most jobs.`);
    lines.push('');
  }

  lines.push(`OUTPUT FORMAT — one block per route, exactly this shape:`);
  lines.push('');
  lines.push(`ROUTE <name> — <N> stops`);
  lines.push(`CREW: `);
  lines.push(`<time>, <City>: <one-line description of work> — <stop-specific callouts; omit the "— ..." part if nothing non-obvious>`);
  lines.push(`<time>, <City>: <one-line description of work> — <stop-specific callouts>`);
  lines.push(`<time>, <City>: <one-line description of work>`);
  lines.push(`Load: <comma-separated specialty tools, or omit this line entirely if standard kit only>`);
  lines.push('');

  lines.push(`IMPORTANT FORMATTING:`);
  lines.push(`  - The "CREW: " line is intentionally blank. Always include it directly under`);
  lines.push(`    the ROUTE header with nothing after the colon — the ops manager fills it in.`);
  lines.push(`  - Each stop's callouts attach to THAT stop, appended after an em-dash " — " on`);
  lines.push(`    the stop's own line, in chronological order. Do NOT pool callouts into a`);
  lines.push(`    separate notes line at the bottom of the route.`);
  lines.push('');

  lines.push(`RULES:`);
  lines.push(`  - One LINE per stop, in chronological order. Format:`);
  lines.push(`    "<TIME>, <CITY>: <description> — <stop callouts>".`);
  lines.push(`    The description says WHAT the job is; the part after " — " carries only the`);
  lines.push(`    callouts the crew needs for THAT stop (access/timing/billing/risk/recycling).`);
  lines.push(`    Omit the " — ..." entirely when a stop has nothing non-obvious to flag.`);
  lines.push(`    Tools/equipment never go on the stop line — those go on the Load line.`);
  lines.push(`    Examples:`);
  lines.push(`      "8:00 AM, Marion: furniture & boat parts — long carry (30' from driveway), heavy items"`);
  lines.push(`      "10:00 AM, Middleborough: upright piano, mattress — customer absent, phone payment required"`);
  lines.push(`      "1:00 PM, Mattapoisett: coolers, umbrellas — repeat customer"`);
  lines.push(`      "11:30AM, Taunton: Basement cleanout"`);
  if (toolsSpecialty.length > 0) {
    lines.push(`  - "Load:" line: ONLY specialty tools from the list above that aren't always on the truck. Example:`);
    lines.push(`      "Load: Big Red, Sawzall"`);
    lines.push(`    Omit the line entirely if standard kit covers everything.`);
  } else {
    lines.push(`  - "Load:" line: any non-standard tools/equipment the crew should bring for a stop on this route. Example:`);
    lines.push(`      "Load: appliance dolly, sawzall"`);
    lines.push(`    Omit the line entirely if no special equipment is needed.`);
  }
  lines.push(`  - Do NOT add bullet points, dashes, or extra headers.`);
  lines.push(`  - Do NOT add a Day Note or DAY NOTE section.`);
  lines.push(`  - Do NOT add a preamble or summary above the first route.`);
  lines.push(`  - Do NOT add "---" separators between routes — just a single blank line.`);
  lines.push('');

  lines.push(`PRIVACY for Notes:`);
  lines.push(`  - Notes may reference customer situations but never quote private details verbatim.`);
  lines.push(`  - "VIP", "repeat customer", "sensitive" are fine. Specifics of personal life are not.`);
  lines.push('');

  lines.push(`WHAT BELONGS IN NOTES (only when present in the data):`);
  lines.push(`  - Long walks (basement, 2nd floor+, attic) where billing impact is likely`);
  lines.push(`  - Confirm-before-arrival flags (price negotiated, customer hesitation, "call ahead")`);
  lines.push(`  - VIP / repeat customer / referral source`);
  lines.push(`  - Dense load / heavy material flags`);
  lines.push(`  - Mattress / e-waste / freon counts when ≥ 2 of one type appear on the route`);
  lines.push(`  - Multi-zone or multi-location pickup`);
  lines.push(`  - Unclear scope ("whatever's left", "anything else customer wants")`);
  lines.push(`  - China cabinets, entertainment centers, particle board — note as junk, NEVER suggest donation`);
  lines.push('');

  // Job data per route
  lines.push(`========== JOBS BY ROUTE ==========`);
  lines.push('');

  const routeNames = Object.keys(routesGrouped).sort();
  for (const routeName of routeNames) {
    const stops = routesGrouped[routeName];
    lines.push(`--- ${routeName} (${stops.length} stops) ---`);
    stops.forEach((wo, i) => {
      lines.push(`STOP ${i + 1} — ${wo.timeLabel}`);
      lines.push(`  Customer: ${wo.clientName}`);
      lines.push(`  Address: ${wo.address.replace(/\n/g, ', ')}`);
      lines.push(`  Items: ${wo.items.replace(/\n/g, '; ')}`);
      if (wo.itemLocations && wo.itemLocations.length > 0) {
        lines.push(`  Item Locations: ${wo.itemLocations.join(', ')}`);
      }
      if (wo.notes) {
        lines.push(`  Notes: ${wo.notes.replace(/\n/g, ' ')}`);
      }
      if (wo.price > 0) {
        lines.push(`  Quoted Price: $${wo.price}`);
      }
      lines.push('');
    });
    lines.push('');
  }

  lines.push(`Generate the plan now. Use the format above exactly. Start with the first ROUTE block — no preamble.`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Parse AI output into per-route blocks
// ---------------------------------------------------------------------------

function parseRouteBlocks(aiText: string, knownRouteNames: string[]): Array<{ routeName: string; stopCount: number; plan: string }> {
  // Split on "ROUTE " at the start of a line. Use a positive lookahead so we
  // keep the "ROUTE " in the captured chunk for context.
  const chunks = aiText.split(/\n(?=ROUTE\s)/);
  const result: Array<{ routeName: string; stopCount: number; plan: string }> = [];

  for (const chunk of chunks) {
    const trimmed = chunk.trim().replace(/\n-{3,}\s*$/g, '').trim();
    if (!trimmed.startsWith('ROUTE')) continue;
    // Extract route name from the header line: "ROUTE Route 1 (MA1REG) — 2 stops"
    const headerMatch = trimmed.match(/^ROUTE\s+(.+?)\s*[—–-]\s*(\d+)\s*stops?/i);
    let routeName = '';
    let stopCount = 0;
    if (headerMatch) {
      routeName = headerMatch[1].trim();
      stopCount = parseInt(headerMatch[2], 10);
    } else {
      // Fallback — match against known route names
      for (const known of knownRouteNames) {
        if (trimmed.indexOf(known) === 0 || trimmed.indexOf(known) === 6) {
          routeName = known;
          break;
        }
      }
    }
    if (!routeName) routeName = 'Unknown Route';
    result.push({ routeName, stopCount, plan: trimmed });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Date helpers (Eastern time)
// ---------------------------------------------------------------------------

function getEasternDate(dayOffset: number): string {
  // Build a YYYY-MM-DD string for the Eastern day that is now + dayOffset days.
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  nowET.setDate(nowET.getDate() + dayOffset);
  const y = nowET.getFullYear();
  const m = String(nowET.getMonth() + 1).padStart(2, '0');
  const d = String(nowET.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

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
    const dayOffset = parseInt(String(body.dayOffset ?? 1), 10);
    // includeTools defaults to true. Set to false to skip the tools query and
    // generate without specialty-tool context — useful for A/B testing AI
    // output and isolating latency.
    const includeTools = body.includeTools !== false;

    if (!franchiseID) {
      return new Response(JSON.stringify({ success: false, error: 'franchiseID required' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    if (dayOffset < -1 || dayOffset > 7) {
      return new Response(JSON.stringify({ success: false, error: 'dayOffset out of range' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!anthropicKey) {
      return new Response(JSON.stringify({ success: false, error: 'ANTHROPIC_API_KEY not configured' }), {
        status: 500,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // 1) Fetch the franchise's internal UUID for tools lookup
    const { data: franchiseRow, error: franchiseErr } = await supabase
      .from('franchises')
      .select('id')
      .eq('external_id', franchiseID)
      .eq('tenant_id', TENANT_ID)
      .single();
    if (franchiseErr || !franchiseRow) {
      return new Response(JSON.stringify({ success: false, error: 'Franchise not found: ' + franchiseID }), {
        status: 404, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // 2) Concurrently fetch workorders (with plan data) AND tools list.
    //    For the workorders call we use a raw fetch with the legacy anon JWT —
    //    the auto-provided SUPABASE_ANON_KEY is now the new "publishable" key
    //    format (sb_publishable_*) which crewlogic-todays-workorders' JWT
    //    verifier rejects. We read LEGACY_ANON_JWT (a user-defined custom
    //    secret) which holds the legacy JWT-format anon key that matches
    //    what the CrewLogic frontend uses.
    const anonKey = Deno.env.get('LEGACY_ANON_JWT') || '';
    if (!anonKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'LEGACY_ANON_JWT custom secret is not configured. Add it under Edge Functions → Secrets with the legacy JWT-format anon key.',
      }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const [workOrdersFetchResp, toolsResp] = await Promise.all([
      fetch(SUPABASE_URL_BASE + '/crewlogic-todays-workorders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + anonKey,
          'apikey': anonKey,
        },
        body: JSON.stringify({ franchiseID, dayOffset, includePlanData: true }),
      }),
      includeTools
        ? supabase.from('tools')
            .select('name, category, description, use_case, is_on_truck')
            .eq('tenant_id', TENANT_ID)
            .eq('franchise_id', franchiseRow.id)
            .eq('is_active', true)
            .order('is_on_truck', { ascending: false })
            .order('name', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (!workOrdersFetchResp.ok) {
      const bodyText = await workOrdersFetchResp.text();
      return new Response(JSON.stringify({
        success: false,
        error: 'workorders fetch failed: status ' + workOrdersFetchResp.status,
        debug: {
          responseBody: bodyText,
          anonKeyLength: anonKey.length,
          anonKeyPrefix: anonKey.slice(0, 12),
          anonKeySuffix: anonKey.slice(-12),
          calledUrl: SUPABASE_URL_BASE + '/crewlogic-todays-workorders',
        },
      }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const workOrdersResp = await workOrdersFetchResp.json();
    if (!workOrdersResp || !workOrdersResp.success) {
      return new Response(JSON.stringify({
        success: false,
        error: 'workorders fetch returned not-success',
        debug: {
          response: workOrdersResp,
          toolsCount: (toolsResp.data || []).length,
          toolsError: toolsResp.error?.message || null,
        },
      }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    const workOrders = (workOrdersResp.workOrders || []) as WorkOrder[];
    const tools = (toolsResp.data || []) as Tool[];

    if (workOrders.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        date: getEasternDate(dayOffset),
        totalJobs: 0,
        routes: [],
        meta: { model: ANTHROPIC_MODEL, note: 'No jobs scheduled for this day' },
      }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // 3) Group workorders by route
    const routesGrouped: Record<string, WorkOrder[]> = {};
    for (const wo of workOrders) {
      const key = wo.route || 'No Route';
      if (!routesGrouped[key]) routesGrouped[key] = [];
      routesGrouped[key].push(wo);
    }

    // 4) Split tools into on-truck and specialty
    const toolsOnTruck = tools.filter((t) => t.is_on_truck);
    const toolsSpecialty = tools.filter((t) => !t.is_on_truck);

    // 5) Build prompt and call Anthropic
    const date = getEasternDate(dayOffset);
    const prompt = buildPrompt(date, routesGrouped, toolsOnTruck, toolsSpecialty);
    const { text: aiText, usage } = await callAnthropic(anthropicKey, prompt);

    // 6) Parse the response into per-route blocks
    const knownRouteNames = Object.keys(routesGrouped);
    const routes = parseRouteBlocks(aiText, knownRouteNames);

    return new Response(JSON.stringify({
      success: true,
      date,
      totalJobs: workOrders.length,
      routes,
      meta: {
        model: ANTHROPIC_MODEL,
        usage,
        toolsCount: tools.length,
        includeTools,
        rawAiText: aiText, // useful for debug — frontend can ignore
      },
    }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });

  } catch (e) {
    const err = e as Error;
    return new Response(JSON.stringify({
      success: false,
      error: 'Unhandled error: ' + (err.message || String(e)),
    }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});