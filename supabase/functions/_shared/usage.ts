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
