// Shared Vonigo helper: parse a Vonigo API response as JSON, turning a down-Vonigo HTML/error page
// (Cloudflare 522 "origin unreachable", gateway timeouts) into a typed VonigoUnavailable error instead
// of a raw "Unexpected token '<'". Callers catch it and return a clean "Vonigo is temporarily
// unavailable" message to the client (the health monitor + DR board are the real mitigations).

export class VonigoUnavailable extends Error {
  constructor() {
    super("vonigo_unavailable");
    this.name = "VonigoUnavailable";
  }
}

// deno-lint-ignore no-explicit-any
export async function vonigoJson(res: Response): Promise<any> {
  const body = (await res.text()).trim();
  try {
    return JSON.parse(body);
  } catch {
    // Non-JSON body = Vonigo's Cloudflare error page / a gateway HTML response = Vonigo is down.
    throw new VonigoUnavailable();
  }
}

// A clean client body for a Vonigo-down situation. Callers: `if (e instanceof VonigoUnavailable) return
// jsonResponse(VONIGO_DOWN_BODY, 503)`.
export const VONIGO_DOWN_BODY = {
  success: false,
  code: "vonigo_unavailable",
  error: "Vonigo is temporarily unavailable. Please try again in a few minutes.",
};
