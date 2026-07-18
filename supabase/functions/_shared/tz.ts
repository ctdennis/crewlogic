// _shared/tz.ts — single source of truth for franchise time zones.
//
// WHY THIS EXISTS
// CrewLogic is multi-tenant across time zones (ET, CT, MT, PT, Arizona/no-DST, Hawaii,
// Alaska). Before this module the state→zone map was copy-pasted into crewlogic-dispatch and
// crewlogic-route-disposal, while crewlogic-todays-workorders and crewlogic-job-plan
// hardcoded 'America/New_York' outright. Four functions, three behaviours. That is why
// "did we fix the timezone thing?" had no clean answer: it was fixed in some copies and not
// others, and nothing made the divergence visible.
//
// Every consumer imports from here. Do not re-declare STATE_TZ in a function.

// US state → IANA zone. NOTE: this is a state's PREDOMINANT zone, not always the correct one
// for a given office. Split states (TX, FL, TN, KY, IN, MI, ND, SD, NE, KS, OR, ID) MUST
// carry an explicit cost_settings.officeTimezone — e.g. #54 El Paso TX is America/Denver
// while this map gives TX → America/Chicago.
export const STATE_TZ: Record<string, string> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
  DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago',
  NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver',
  NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
  WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver',
};

export const DEFAULT_TZ = 'America/New_York';

/**
 * Resolve a franchise's IANA zone from its cost_settings JSONB.
 * Order: explicit officeTimezone → STATE_TZ[officeState] → Eastern default.
 *
 * As of migrations 0050/0051 every prod franchise carries an explicit officeTimezone, and
 * the Settings UI (v5.50.90+) makes owners confirm it — so the two fallbacks should now be
 * rare. They are kept for robustness, but reaching the Eastern default means the franchise
 * has neither a zone nor a usable state, which is a DATA GAP worth surfacing (that silent
 * default is what hid #56 Orange County running on Eastern for weeks). Callers that can log
 * should pass a label to resolveTimezoneLogged.
 */
export function resolveTimezone(costSettings: unknown): string {
  try {
    const cs = (costSettings || {}) as Record<string, unknown>;
    const explicit = String(cs.officeTimezone || '').trim();
    if (explicit) return explicit;
    const st = String(cs.officeState || '').trim().toUpperCase();
    return STATE_TZ[st] || DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

/** As resolveTimezone, but logs when it falls through to the silent Eastern default. */
export function resolveTimezoneLogged(costSettings: unknown, label: string): string {
  const cs = (costSettings || {}) as Record<string, unknown>;
  const tz = resolveTimezone(costSettings);
  const explicit = String(cs.officeTimezone || '').trim();
  const st = String(cs.officeState || '').trim().toUpperCase();
  if (!explicit && !STATE_TZ[st]) {
    console.warn(`[tz] ${label}: no officeTimezone and no usable officeState — defaulting to ${DEFAULT_TZ}. This franchise needs its address/timezone set.`);
  }
  return tz;
}

/** Calendar Y/M/D as seen in `tz` right now, plus `dayOffset` days. DST-safe via Intl. */
export function todayPartsInTz(tz: string, dayOffset = 0): { year: number; month: number; day: number } {
  const s = new Date().toLocaleString('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) throw new Error(`[tz] failed to read date in ${tz}: ${s}`);
  return { year: +m[3], month: +m[1], day: +m[2] + dayOffset };
}

/** "today + offset" as YYYYMMDD in `tz`. */
export function dayIDInTz(tz: string, dayOffset = 0): string {
  const p = todayPartsInTz(tz, dayOffset);
  const dt = new Date(Date.UTC(p.year, p.month - 1, p.day));
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Midnight of (today + dayOffset) in the franchise's zone, encoded the way Vonigo expects.
 *
 * READ THIS BEFORE "FIXING" IT. Vonigo's WorkOrder DATE fields use a naive convention: the
 * local clock face stored as if it were UTC. So we deliberately encode with Date.UTC on the
 * franchise's LOCAL calendar components. That encoding is timezone-agnostic — Eastern
 * midnight July 18 and Pacific midnight July 18 produce the SAME integer — and it is correct.
 *
 * The bug this replaces was never the encoding; it was the DAY SELECTION. The old
 * getEasternMidnightEpoch read the calendar components from 'now in America/New_York', so for
 * a Pacific franchise the day rolled over at 9 PM local and the caller asked for tomorrow.
 * Taking the components in the franchise's own zone fixes that while preserving the encoding.
 */
export function franchiseDayEpoch(tz: string, dayOffset = 0): number {
  const p = todayPartsInTz(tz, dayOffset);
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0) / 1000);
}
