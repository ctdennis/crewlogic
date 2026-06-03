# Project Status — CrewLogicAI

**This file is the single source of truth for project / build / production-rollout status.**
Read it *first* for any status question — do not re-derive status by re-analyzing `index.html` or the
edge functions unless an entry is stale (see freshness rule) or you are doing a scheduled re-verify.

## Update protocol (check → update → recheck)

1. **Check (before a change):** read the relevant row here to confirm current state before starting work.
2. **Update (during the change):** in the *same commit* as the change, update the row — Build / Prod /
   Version / Open items — so the tracker never lags the code.
3. **Recheck (after the change):** verify the change landed as described and stamp **Last verified** with
   today's date. If you couldn't verify a field (e.g. prod data), say so in Notes rather than guessing.

**Freshness rule:** trust an entry whose *Last verified* is recent. If it's old or the code in that area
changed since, re-verify before relying on it. Never overstate prod rollout — "code deployed" ≠ "in active
use by a prod tenant"; keep those distinct.

**Status legend:** `Done` · `In progress` · `Planned` · `Not started` · `Dropped`
**Prod rollout:** `Live` (in prod & in use) · `Deployed` (code/fn in prod, not yet exercised by a prod tenant) · `Dev only` · `n/a`

---

## Features — Standalone / No-CRM Mode (`docs/Feature-StandaloneMode/`)

| Project | Spec | Build | Prod rollout | Version | Last verified | Open items |
|---|---|---|---|---|---|---|
| Stage A: Native Pricing + Customers | [CL-SPEC-001](Feature-StandaloneMode/CL-SPEC-001_StageA_Pricing_Customers.md) | **Done** | Deployed (`crewlogic-pricing` ACTIVE; **no native tenants in prod yet** — owner-confirmed 2026-06-02, so prod is code-ready and awaiting first native user) | — | 2026-06-02 | (1) native send uses "Generate PDF", not a "Finalize & Send" button; (2) 4 Route-Optimizer/Storage quick-select buttons hardcode `16` cy (cosmetic) |
| Town Price Lookup | [CL-SPEC-002](Feature-StandaloneMode/CL-SPEC-002_TownPriceLookup.md) | **Done** (dual-track; verified in-browser on dev) | **Live** (v5.22.2, promoted 2026-06-02) | v5.22.2 | 2026-06-02 | Migration 0005 applied to dev + **prod**. Native = `<datalist>` autocomplete from enriched `price_list_zips`; Vonigo = town + state dropdown scoped to `cost_settings.serviceStates`, default `officeState`; village-name not-found hint. Parked: per-estimator default state |
| Phase 2: Native Auth (Supabase Auth, invite-first) | [CL-SPEC-003](Feature-StandaloneMode/CL-SPEC-003_Phase2_NativeAuth.md) | **Done** | **Live** (login V2 shipped v5.18.0) | v5.18.0 | 2026-06-02 | Magic-link only by design (no password auth). Next: Phase 3 RLS |
| Phase 3: RLS / SEC-1 | [CL-SPEC-004](Feature-StandaloneMode/CL-SPEC-004_Phase3_RLS_SEC1.md) | **In progress** (started 2026-06-03) | Dev only | v5.23.0 (dev) | 2026-06-03 | Done in dev: scope helpers (0006); client JWT in `supabaseFetch` (§6); dev bypass mints a **real Supabase session** (`DEV_AUTH.md`); **scoped RLS applied + verified on 16 tables** — customers (0007) + estimates, price_lists/blocks/items/zips, customer_price_lists, job_plans, crew_members, tools, campaigns, yard_signs+sign_* (0008). Verified in-browser (customers) + SQL (reads filter correctly). Remaining tables: profiles, franchises, tenants, invites/feedback (carve-outs), vonigo_*. Then §4 carve-outs. **Prod gating dep:** Google→Supabase Auth (link by email) so all prod users get `auth.uid()` |

## Platform / Infrastructure

| Project | Build | Prod rollout | Last verified | Notes |
|---|---|---|---|---|
| Dev/prod Supabase separation | **Done** (Supabase layer) | Live | 2026-06-02 | prod `ozfkpxyachigfpcmvekz` + dev `bagkimfwmpwjfhfhmsrb` (`crewlogic-dev`). Frontend is still single-deploy |
| `supabase/migrations/` folder | **Done** | n/a | 2026-06-02 | Sequential `NNNN_*.sql` (`0001`–`0004`). Apply to dev first, then promote |
| Edge function source under git | **Done** | Live | 2026-06-02 | All 14 functions committed & verified byte-identical to prod |
| n8n → Edge Functions migration | **In progress** | Mixed | 2026-06-02 | Still in n8n: estimate `delete` + `searchClients` (need Vonigo OAuth), large route-optimization engine |
| Deploy workflow → Claude Code direct | **In progress** | — | 2026-06-02 | Repo moved to `~/code/crewlogic`; now committing/pushing from Claude Code (was Downloads→GitHub Desktop) |
| Onboarding process | **Not started** | n/a | 2026-06-02 | New todo. At signup / Vonigo provisioning, capture franchise `serviceStates` (the multi-state handful) + a per-estimator default state. Estimators (magic-link) may work in a different state than the office (e.g. estimator in CA, office in AZ) → estimator default state falls back to franchise `officeState`. `serviceStates` also owner-editable in Settings. Feeds Town Price Lookup (Vonigo track) |

---

_Convention: keep this file terse. One row per project. Link to the spec for detail. Stamp **Last
verified** whenever you confirm a row against reality._
