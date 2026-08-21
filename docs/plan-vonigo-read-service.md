# Plan — Vonigo Read-Only Access Service for Franchisees (FW-69)

**Status:** DISCUSSION CAPTURED / DRAFT for Owner review · created 2026-08-20 · no code, no schema
**Author:** Claude (master), Sr. Architect hat
**Register:** FW-69 (`.HUB/Hub.md` Future-Work Register + `docs/CrewLogic-Future-Work-Register.xlsx`)
**Related:** `docs/plan-integration-framework.md` (CrewLogic's OWN multi-CRM ingestion — distinct), the ~20 `memory/vonigo-*.md` notes, `docs/vonigo-api-notes.md`, `docs/vonigo-dispatch-map-notes.md`, `supabase/functions/_shared/vonigo.ts`.

---

## 0. One-line summary

Package the months of reverse-engineered Vonigo API knowledge into a **read-only** product other Junkluggers franchisees can point their own Claude Code (or any agent/script) at, so they can build their own tools over Vonigo without re-doing the reverse engineering. Ship as a **self-hosted knowledge pack**: an instruction pack + a read-only access helper, with `/system/objects` introspection so the agent self-discovers anything not pre-documented.

---

## 1. Where the Vonigo knowledge lives today (the raw material)

This is the asset. It is already written; the product is packaging it.

- **Memory notes (~20 files):** `~/.claude/projects/-Users-charlesdennis-code-crewlogic/memory/vonigo-*.md`
  — status/label codes, field maps (Client/Contact/Location), availability query, campaigns endpoint, route model, system-objects introspection, booking recipe, five-type recognition, duplicate-customer behavior, pull photos/documents, etc.
- **Repo docs:** `docs/vonigo-api-notes.md`, `docs/vonigo-dispatch-map-notes.md`, `docs/vonigo-mark-complete-findings.md`, `docs/contract-vonigo-adapter.md`, `docs/contract-bizdev-*-booking.md`.
- **Code (the working reference implementation):** `supabase/functions/_shared/vonigo.ts` (MD5 `/security/login/` → short-lived `securityToken`, request helpers) + ~15 `crewlogic-*` edge functions that consume it.

The reverse engineering is **done for CrewLogic's needs**. The open risk (see §6) is that a franchisee will ask something CrewLogic never needed — introspection is how we cover the unknown without pre-enumerating every endpoint.

---

## 2. The problem this solves

Other Junkluggers franchisees want to build their own tools over Vonigo (reporting, dashboards, one-off scripts). Vonigo's raw API is undocumented-in-practice: MD5 login flow, opaque numeric field/option IDs (field 201 = label, 181 = status, 949 = invoice subtotal…), franchise-scoped picklists, naive-Eastern date conventions, duplicate-customer semantics. Every franchisee hits the same multi-month wall we did.

CrewLogic already climbed that wall. The knowledge is a reusable asset.

---

## 3. Scope decision — READ ONLY (for now)

**Owner decision (captured): keep it read-only for now.** No create/edit/delete/deactivate through this service. Rationale:

- Vonigo is **production** — there is no dev Vonigo. Any write hits the live Junkluggers CRM. Handing external parties a write path multiplies blast radius and support burden.
- Read-only is the 80% of what franchisees actually want first (reporting/analysis).
- Writes can be a later, gated phase once the read product is proven and the moat/pricing questions are settled.

**Enforcement is structural, not advisory:** the access helper must hard-block Vonigo write methods (the `method` param values that mutate — 2/3/4/5 on the data endpoints) and only permit read shapes (`method:-1`/`method:1` reads, `/resources/*`, `/system/objects/`, `GET`s). A blocked write returns an explicit "read-only service" error, never silently passes through.

---

## 4. Architecture — two artifacts + introspection

### Artifact A — Read-only access mechanism
A small helper the franchisee runs locally that:
- Handles the MD5 `/security/login/` → `securityToken` dance (token caching + refresh) so the agent never re-implements auth.
- Exposes ONE generic read primitive: `vonigo_get(endpoint, params)` (or an equivalent `vonigo-read` CLI). Generic passthrough beats a hand-maintained typed method per endpoint — it covers endpoints we haven't documented.
- **Hard-blocks writes** (§3).
- Ships as either (a) a tiny CLI/helper script the agent shells out to, or (b) a **stdio MCP server** exposing `vonigo_get` + a couple of convenience read tools. MCP is the cleaner long-term shape (typed tools, `claude mcp add`, discoverable), but a plain read-only helper script is the lower-effort starter. **Open decision D-2.**
- Credentials stay in the franchisee's own `.env` (their Vonigo login) — CrewLogic never holds them in the self-hosted model.

### Artifact B — Instruction pack (the knowledge)
- A `CLAUDE.md` (or `AGENTS.md`) that teaches an agent how to interact with Vonigo: the auth model, the "always introspect first" habit, the naive-Eastern date convention, franchise-scoped picklists, duplicate-customer caveat, the key field/option IDs, and worked examples.
- A "how to query Vonigo" skill/cheat-sheet distilled from the existing memory + docs (§1).
- A `.env.example` and a runnable **`/system/objects` discovery example** so the first thing a new user does is prove the connection and list a real object's fields.

### The introspection backstop (covers the unknown)
`/system/objects/` (POST `method:1`, `objectID=<N>`) returns an object's Fields + Options at runtime. Bundling this as the documented first move means the agent can **self-discover** field/option IDs for asks CrewLogic never needed — instead of us pre-enumerating every endpoint. This is the answer to "we don't know what will be asked."

---

## 5. Moat / distribution trade-off (the strategic call)

| Model | Effort | Moat | Creds | Notes |
|---|---|---|---|---|
| **Self-hosted knowledge pack** (recommended) | Low | Low — hands over the maps | Franchisee holds own Vonigo creds | Acceptable for a franchise-family, read-only audience; fastest to value |
| **Hosted gateway service** | High | High — maps stay private behind our API | CrewLogic holds/receives creds | Run infra, hold other franchises' credentials, support burden, liability |

**Recommendation:** start with the **self-hosted knowledge pack, read-only.** The audience is the Junkluggers franchise family (aligned interests, not competitors), the data is read-only, and the maps' value is mostly in having done the work — giving them away to the family is low-cost goodwill and the fastest path to proving demand. A hosted gateway (to protect the maps + monetize) is a later pivot if demand + a pricing model justify holding creds and running infra. **Open decision D-1.**

---

## 6. "We don't know what will be asked" — how the design absorbs it

Owner framed the core uncertainty: *the research is done for CrewLogic's functionality, but we don't know what a franchisee will ask or how well our current knowledge base supports it.*

The design answers this three ways, so we don't have to pre-enumerate:
1. **Generic `vonigo_get` passthrough** — any read endpoint works, documented or not.
2. **`/system/objects` introspection as the documented first move** — the agent discovers field/option IDs itself.
3. **The instruction pack teaches the *method*, not just the *answers*** — "when you hit an unknown field ID, introspect the object" is a rule, not a lookup.

If a franchisee asks something genuinely novel, the agent introspects, figures it out, and (optionally) we fold the finding back into the pack.

---

## 7. Rollout — start as a small starter repo

**Phase 0 (starter repo, read-only knowledge pack):**
- `CLAUDE.md` (interaction guide + Vonigo conventions + introspect-first rule)
- read-only `vonigo-read` helper (auth handled, `vonigo_get`, writes blocked)
- `.env.example` (franchisee's own creds)
- a `/system/objects` discovery example + 2–3 worked read examples (today's work orders, an invoice subtotal, a picklist)
- a distilled "how to query Vonigo" skill/cheat-sheet from existing memory/docs

**Phase 1 (optional):** wrap the helper as a stdio **MCP server** (`vonigo_get` + convenience read tools) for one-line `claude mcp add` onboarding.

**Phase 2 (later, gated):** consider a hosted gateway and/or a gated write path — only if demand + pricing justify holding creds + running infra + accepting write blast radius on production Vonigo.

---

## 8. Open decisions (need Owner input)
- **D-1 — Moat model:** self-hosted knowledge pack (recommended) vs hosted gateway. Governs whether CrewLogic ever holds other franchises' Vonigo creds.
- **D-2 — Access shape for Phase 0:** plain read-only helper script (lower effort) vs stdio MCP server (cleaner onboarding). Recommendation: script first, MCP as Phase 1.
- **D-3 — Distribution:** private repo shared per-franchise vs an internal Junkluggers-network distribution. Who gets it and how.
- **D-4 — Support model:** is this "here's the repo, good luck" or a supported product? Sets the effort/liability ceiling.
- **D-5 — Pricing / monetization:** free goodwill to the franchise family, or a paid product? (Interacts with D-1: only the hosted gateway realistically monetizes.)
- **D-6 — Write path (future):** if/when writes are ever added, they inherit the Vonigo hard-approval-gate discipline; out of scope for now.

---

## 9. Guardrails that carry over
- **Read-only is structural** — the helper blocks Vonigo write methods, not just documents that it shouldn't (§3).
- **No secrets in the repo/docs** — `.env.example` only; franchisee supplies their own Vonigo creds.
- **Vonigo is production** — this is exactly why writes stay out for now.
- **Regression-free to CrewLogic** — this is a new standalone starter repo; it does NOT touch `index.html` or the CrewLogic edge functions.

---

## 10. Decision needed
Owner: approve **direction** (self-hosted read-only knowledge pack) and the **Phase 0 starter repo** as the first artifact, or redirect on D-1/D-2. No code until the direction is confirmed. The knowledge-pack content can start being distilled from existing memory/docs regardless, since that's pure documentation.
