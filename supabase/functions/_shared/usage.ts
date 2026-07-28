// _shared/usage.ts — append-only usage/metering logger for CrewLogic edge functions.
//
// Fire-and-forget safety: logUsage NEVER throws. A metering failure must never break
// or slow the user-facing request, so every code path here is wrapped and swallows
// errors (logging to the function console only). Inserts one row into public.usage_events.
//
// `sb` is a service-role supabase-js client (created with SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY) — usage_events is service-role only (RLS, no policies).

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

export interface UsageFields {
  tenantId?: string | null;
  franchiseId?: string | null;
  userId?: string | null;
  eventType: string;
  model?: string | null;
  units?: number;
  // deno-lint-ignore no-explicit-any
  metadata?: Record<string, any> | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// usage_events.{tenant_id,franchise_id,user_id} are uuid columns. Callers may hand us an
// external id ("90") or undefined; coerce anything that isn't a real UUID to null so the
// insert never fails on a type mismatch (the raw value, if any, can be stashed in metadata
// by the caller). Keeps logging non-blocking even with imperfect attribution.
function uuidOrNull(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim() : null;
}

export interface UsageCounts { estimates: number; aiCalls: number; photos: number; }

// Count a franchise's billable usage in [startIso, endIso), as THREE distinct dimensions:
//   aiCalls   = # of ai.analyze_estimate + ai.volume_check events. Each is one Anthropic call — the
//               COST unit. One estimate is 1-to-many with AI calls (one per room analyzed + each
//               manual re-analyze; a volume check = 1). This is the enforced dimension.
//   photos    = SUM(metadata.images) over those same events (also enforced).
//   estimates = # of DISTINCT saved estimates created in-period (estimates table, deleted_at IS NULL).
//               A re-run does NOT add one; a delete removes one. Advisory only (never blocks) — it's
//               the human-facing "how many jobs did I estimate" number, not the cost driver.
// Never throws — a counting failure returns zeros so the caller can fail-open (never block a customer
// on a metering hiccup). The two queries are independent; either failing zeroes only its own dimension.
export async function countUsage(
  sb: SupabaseClient,
  franchiseId: string,
  startIso: string,
  endIso: string,
): Promise<UsageCounts> {
  let aiCalls = 0, photos = 0, estimates = 0;
  try {
    const { data, error } = await sb.from('usage_events')
      .select('event_type, metadata')
      .eq('franchise_id', franchiseId)
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .in('event_type', ['ai.analyze_estimate', 'ai.volume_check']);
    if (error) { console.error('[usage] ai-call count failed:', error.message || error); }
    else for (const r of (data || [])) {
      aiCalls++; // both a per-room analyze and a volume check are AI calls (same Anthropic cost)
      const img = r.metadata && (r.metadata as { images?: unknown }).images;
      if (typeof img === 'number' && img > 0) photos += img;
    }
  } catch (e) { console.error('[usage] ai-call count failed:', e); }
  try {
    const { count, error } = await sb.from('estimates')
      .select('id', { count: 'exact', head: true })
      .eq('franchise_id', franchiseId)
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .is('deleted_at', null);
    if (error) console.error('[usage] estimate count failed:', error.message || error);
    else estimates = count || 0;
  } catch (e) { console.error('[usage] estimate count failed:', e); }
  return { estimates, aiCalls, photos };
}

// Current usage window. Launch: calendar month (no subscribers yet). When a franchise is subscribed,
// the caller passes the Stripe current_period_start/end instead. Returns ISO [start, end).
export function calendarMonthPeriod(nowMs: number): { startIso: string; endIso: string } {
  const d = new Date(nowMs);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export async function logUsage(sb: SupabaseClient, fields: UsageFields): Promise<void> {
  try {
    const row = {
      tenant_id: uuidOrNull(fields.tenantId),
      franchise_id: uuidOrNull(fields.franchiseId),
      user_id: uuidOrNull(fields.userId),
      event_type: fields.eventType,
      model: fields.model ?? null,
      units: (fields.units === undefined || fields.units === null) ? 1 : fields.units,
      metadata: fields.metadata ?? null,
    };
    const { error } = await sb.from('usage_events').insert(row);
    if (error) console.error('[usage] log failed:', error.message || error);
  } catch (e) {
    console.error('[usage] log failed:', e);
  }
}
