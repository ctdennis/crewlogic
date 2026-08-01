# Franchise-Scoped NL Reporting & Analysis Assistant (Spec)

**Status:** Draft for review — brainstorm output, NOT approved for build.
**Origin:** Owner brainstorm 2026-08-01 ("let the office manager ask questions about their data by voice or text, guard-railed by their franchise, and export the answer").
**Tracker:** FW-62 (see `.HUB/Hub.md`).
**Related:** FW-59 (live ETA / telematics), FW-60 §6a (dwell-from-geofence-history — this assistant generalizes it), the AI-calls meter, `crewlogic-ai`.

---

## 1. Problem & goal

The office manager (OM) has a rich operational + historical dataset (Vonigo jobs, telematics, geofence dwells, charges) sitting in Supabase, but no way to *ask* it questions without an engineer writing SQL. Goal: an **in-app assistant** where the OM asks a question — by **voice or text** — about **their own franchise's** data and gets a clear answer, a small table, and a **one-tap export to CSV (opens in Excel)**.

Example questions (owner's own):
- "How many trucks are on the road today?"
- "How many trucks are active right now?"
- "What's the average wait at the Raynham transfer station at 3pm on a Saturday?"
- "How many jobs did we complete last week, and what was the average job size?"

**Non-goal (v1):** writing/modifying data; cross-franchise or corporate roll-ups; predictive modeling. Read + report only.

## 2. Two question types → two data sources

Questions split cleanly, and the assistant routes each to the right source:

| Type | Example | Source |
|---|---|---|
| **Live / operational** | trucks on the road today, trucks active *right now*, who's at HQ | Telematics (`crewlogic-trucks` live state) + today's Vonigo work orders. Answered from the live edge functions, not raw SQL. |
| **Historical / analytical** | avg dwell at a facility by day/hour, jobs completed, avg job size, on-time %, utilization | The **Supabase store** (`geofence_alerts`, jobs mirror, `route_volume_estimates`, etc.) via read-only SQL. |

The router decides live-vs-historical from the question (a "today/right now" cue → live; an average/trend/"last week"/"on Saturdays" cue → historical).

## 3. Architecture — hybrid, safest-first

1. **Curated "report skills"** (v1 core): a set of pre-written, **parameterized, safe** queries for the common asks. The AI's job is only to (a) pick the right skill and (b) fill its parameters (facility name, day-of-week, hour, date range). It never writes raw SQL. Fast, cheap, predictable, impossible to break out of. Covers ~80% of what an OM asks.
2. **Guarded read-only text-to-SQL fallback** (v2): for novel questions no skill covers, the AI drafts a SELECT that runs as a **franchise-scoped, read-only role** (see §4). Even a wrong or weird query stays safe and can't leak or mutate.

Ship #1 first; add #2 only once the guardrail is proven in production.

## 4. THE GUARDRAIL (the make-or-break — security)

A multi-tenant NL query tool's hard problem is **not** answering questions — it's guaranteeing franchise A can never see franchise B's data, and nothing can ever be modified. This is enforced at the **data layer**, never by trusting the model to add a `WHERE`:

- **Franchise scope is injected server-side**, from the caller's authenticated session (`franchise_id`), into every query — the OM's question can't override it, and the model is never the thing that "remembers" to scope.
- **Read-only, franchise-scoped DB role.** The text-to-SQL fallback executes as a Postgres role that (a) has **SELECT only** (no INSERT/UPDATE/DELETE/DDL) and (b) is bound by **RLS policies keyed to the session's franchise_id**, so even a query with no `WHERE` returns only that franchise's rows. Mirrors the `prod-readonly-sql.sh` read-only-transaction pattern, server-side and per-tenant.
- **Statement timeout** (e.g. 5s) so no question — accidental or adversarial — can melt the DB.
- **Curated skills take the same scope**: every parameterized skill query is franchise-filtered by construction.
- **Output is data only** — never echo the generated SQL, connection details, or other franchises' identifiers to the client (per the no-internals-to-client rule).

If any of the above can't be guaranteed, the feature doesn't ship. The guardrail is the gate, not a nice-to-have.

## 5. THE DATA-CONTEXT PROMPT (the key — owner-emphasized)

The single biggest determinant of correctness is the **data-context the AI is given** — a curated, versioned "data dictionary + quirks" that teaches the model the schema *and the gotchas*, so it queries correctly. This is the accumulated tribal knowledge, formalized. It is a **living artifact** that grows every time we learn a new quirk.

For each relevant table/source it encodes: purpose · the franchise-scope column · the timestamp columns **and their timezone** · and the **QUIRKS** that trip up a naive query. Examples we already know (this is exactly the "don't read the entry rows, use the exit row's duration" kind of hint the owner called out):

- **`geofence_alerts` (dwell / facility waits):** dwell time = the **`duration`** column (seconds) on **`event_type = 'geofence_exit'`** rows ONLY. Entry (`geofence_entry`) events are **sparse/incomplete** — do NOT pair entry→exit; the exit row already carries the whole dwell. **Filter blips** (`duration < ~120s` = truck clipping the fence edge, not a real visit). **Cap missed-exits** (`duration > ~2h`). Facility name is in `geofence_name` (e.g. `'Raynham - Transfer'`). `start_time`/`end_time` are `timestamptz` (UTC) — **convert to the franchise's local timezone** before any day-of-week/hour filter.
- **Timezone (multi-tenant):** always resolve the **franchise's own timezone** (Eastern for #90; the app has `STATE_TZ`/`resolveTimezone`) and convert UTC timestamps to it. "Saturday" = local day-of-week 6 in that TZ. Never assume Eastern for a non-Eastern franchise. **Vonigo exception:** some Vonigo date fields use a naive-Eastern (clock-as-UTC) convention.
- **Jobs / Vonigo:** "completed" = status archived/complete; **booked-online = field 9920** (durable) not the note text; **charges are a separate object** (truckload volume = the charge `name` fraction × qty); label codes (9973 Est-Only, 9975 Est-Converted, 245 Est-Completed, etc.).
- **Trucks (live):** "active right now" = a telematics **state** (moving/parked), not just "has a row"; offline/unplugged is a distinct state.
- **Money/pricing:** prices/limits live in the DB, resolved per franchise — never a code constant.

This document *is* the deliverable that makes the assistant trustworthy. It should live in the repo, be reviewed like code, and every session that discovers a data quirk appends to it (several of the above were learned in the 2026-07/08 sessions). Think of it as the AI's onboarding manual for our data.

## 6. Report-skill catalog (starter — v1)

Each is a parameterized, franchise-scoped, read-only query with a clear title + the params the AI fills:
- **Trucks on the road today** (count of trucks with today's assigned jobs / live movement)
- **Trucks active right now** (live telematics state = moving/parked, offline flagged)
- **Facility dwell** — avg + median + count, params: facility, day-of-week, hour-of-day, date range (the Raynham-Saturday query, generalized; blip/outlier hygiene baked in)
- **Jobs completed** — count + $ total + avg job size, params: date range (avg excludes non-completed, per the board rule)
- **On-time %** — params: date range / route
- **Truck utilization / field hours** — from geofence yard-departure → return (ties to FW-61)

Every skill returns a small result table + a plain-English summary sentence.

## 7. Answer + export

- Response = a **one-line plain answer** ("~22 min average; ~18 min typical, over 25 Saturdays") + a **small table** of the underlying rows + a **📥 Export CSV** button (CSV opens in Excel; no server round-trip needed for the download).
- Show the **method + sample size** so the OM can trust it (e.g. "25 Saturday visits, blips under 2 min excluded") — same discipline as a good analyst.

## 8. Input — voice + text

- **Text:** a query box (reuse the existing Dispatch command-bar pattern).
- **Voice:** mic → transcript → same pipeline (the app already has a voice command surface).
- Keep a short **conversation memory** so follow-ups work ("...and at 3pm?" after a facility question).

## 9. Model + metering

- Runs through **`crewlogic-ai`**, franchise-scoped from the session.
- Consumes the **AI-calls meter** (FW-59) — a reporting question = an AI call; ties into the usage/entitlement model. (Note: identifier-exactness rule doesn't apply — this is analysis, not part-number generation — so model tier can be chosen for reasoning quality/cost.)

## 10. Phasing

- **v1** — curated report skills (§6) + the data-context doc (§5) + the franchise-scope guardrail (§4) + text input + CSV export. Covers the owner's examples end-to-end.
- **v2** — voice input; the guarded read-only text-to-SQL fallback (§3.2) for novel questions; conversation memory for follow-ups.
- **v3** — scheduled/saved reports ("email me the weekly summary"), more skills, charts.

## 11. Open decisions (for owner)

1. **Scope of "guard-railed":** franchise-only, or should an owner with multiple franchises get a roll-up across *their* franchises (still never cross-tenant)?
2. **v1 skills-only vs. include the text-to-SQL fallback:** start locked to curated skills (safest), or include the guarded fallback from day one?
3. **Where it lives in the UI:** a new "Ask / Reports" module tile, or folded into the existing command bar?
4. **Who can use it:** owners only, or estimators/OMs too (role gate)?
5. **Export format:** CSV only (Excel-openable) for v1, or true `.xlsx`?

---

*No code until this spec is approved. The **data-context doc (§5)** is the first artifact to build/curate regardless — it's the asset that makes everything else trustworthy, and it can start now from the quirks already logged in memory.*
