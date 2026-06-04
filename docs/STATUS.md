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
| Stage A: Native Pricing + Customers | [CL-SPEC-001](Feature-StandaloneMode/CL-SPEC-001_StageA_Pricing_Customers.md) | **Done** | Deployed (`crewlogic-pricing` ACTIVE; **no native tenants in prod yet** — owner-confirmed 2026-06-02, so prod is code-ready and awaiting first native user) | — | 2026-06-02 | (1) native send uses "Generate PDF", not a "Finalize & Send" button; (2) 4 Route-Optimizer/Storage quick-select buttons hardcode `16` cy (cosmetic); (3) **CPL per-item discounting won't work for native price books** — `CPL_CATEGORIES` (index.html ~4844) matches blocks by Vonigo canonical names (`Volume Charges`, `Additional Labor`, `Single Item Price List`, recycling surcharges); native books with other block names (dev seed uses `Volume`/`Labor`/`Surcharges`/`Single Items`) load no per-item items. Fix: align native block naming or map CPL by `block_type` (found 2026-06-03) |
| Town Price Lookup | [CL-SPEC-002](Feature-StandaloneMode/CL-SPEC-002_TownPriceLookup.md) | **Done** (dual-track; verified in-browser on dev) | **Live** (v5.22.2, promoted 2026-06-02) | v5.22.2 | 2026-06-02 | Migration 0005 applied to dev + **prod**. Native = `<datalist>` autocomplete from enriched `price_list_zips`; Vonigo = town + state dropdown scoped to `cost_settings.serviceStates`, default `officeState`; village-name not-found hint. Parked: per-estimator default state |
| Phase 2: Native Auth (Supabase Auth, invite-first) | [CL-SPEC-003](Feature-StandaloneMode/CL-SPEC-003_Phase2_NativeAuth.md) | **Done** | **Live** (login V2 shipped v5.18.0) | v5.18.0 | 2026-06-02 | Magic-link only by design (no password auth). Next: Phase 3 RLS |
| Phase 3: RLS / SEC-1 | [CL-SPEC-004](Feature-StandaloneMode/CL-SPEC-004_Phase3_RLS_SEC1.md) | **Done** — RLS enforced (cutover 2026-06-03) | **Live** (prod, v5.23.2) | v5.23.2 | 2026-06-03 | All public tables franchise/tenant-scoped (migrations 0006–0010, dev+prod) or deny-all (vonigo_*); client sends user JWT (§6); `crewlogic-link-identity` auto-links on login. Prod cutover done in order: link-identity deployed → backfilled mark (gustavo auto-links next login) → client v5.23.2 live → policies applied. Verified charles.dennis reads 48 estimates under RLS; stranger sees 0. **Owner live-verified in prod 2026-06-03** (estimate creation, cover-photo retrieval, volume estimate, price lookup — all good on a junkluggers.com login). **Follow-ups:** §8 `estimate-photos` storage scoping — `authenticated` access now granted so logged-in users can read/write photos (migration `0011`, dev+prod 2026-06-03); per-franchise *path* scoping still deferred; fuller cross-tenant test suite (§10) |

## Platform / Infrastructure

| Project | Build | Prod rollout | Last verified | Notes |
|---|---|---|---|---|
| Dev/prod Supabase separation | **Done** (Supabase layer) | Live | 2026-06-02 | prod `ozfkpxyachigfpcmvekz` + dev `bagkimfwmpwjfhfhmsrb` (`crewlogic-dev`). Frontend is still single-deploy |
| `supabase/migrations/` folder | **Done** | n/a | 2026-06-02 | Sequential `NNNN_*.sql` (`0001`–`0004`). Apply to dev first, then promote |
| Edge function source under git | **Done** | Live | 2026-06-02 | All 14 functions committed & verified byte-identical to prod |
| n8n → Edge Functions migration | **In progress** | Mixed | 2026-06-02 | Still in n8n: estimate `delete` + `searchClients` (need Vonigo OAuth), large route-optimization engine |
| Deploy workflow → Claude Code direct | **In progress** | — | 2026-06-02 | Repo moved to `~/code/crewlogic`; now committing/pushing from Claude Code (was Downloads→GitHub Desktop) |
| Onboarding process | **Not started** | n/a | 2026-06-02 | New todo. At signup / Vonigo provisioning, capture franchise `serviceStates` (the multi-state handful) + a per-estimator default state. Estimators (magic-link) may work in a different state than the office (e.g. estimator in CA, office in AZ) → estimator default state falls back to franchise `officeState`. `serviceStates` also owner-editable in Settings. Feeds Town Price Lookup (Vonigo track) |

## Backlog / feature requests

| Request | Status | Notes |
|---|---|---|
| Vonigo deep-link from estimate | **Not started** (2026-06-03) | Make the `Vonigo #<id>` reference clickable → opens that estimate/work-order directly in Vonigo. Appears on the post-submit screen ("Submitted to Vonigo — Estimate #678497") and the estimates-list card. Need the Vonigo estimate-URL pattern |
| Show estimate IDs on the estimate editor view | **Not started** (2026-06-03) | On the estimate detail/editor (the contact/Street-View/Notes view), surface the **Vonigo estimate #** + **CrewLogic estimate ID**, matching the estimates-list card (`✓ Vonigo #678497  ID:1780322856756`). Pairs with the deep-link above (the Vonigo # there should also be clickable) |
| Native "set up your price book" prompt | **Partly done** (dev, v5.23.3) | Estimate editor now shows a clear "No price book set up yet → Set up Price Book" notice (with CTA) when native pricing can't load, instead of silently dimming the toolbar buttons (fixes the silent-failure that blocked estimate creation for Big Jakes in prod). Home Price Lookup badge is Vonigo-only, suppressed for native (v5.23.2). **Still:** a home/native setup prompt + general onboarding |
| Delete the default / only price list | **Done** (dev, v5.24.0) | Delete (✕) now shows for the default list too. `deletePriceList()`: blocks deleting the Default while other lists exist (prompts to make another Default first); allows deleting the last/only list (→ no price book, new-setup notice kicks in). Contextual confirm shows the ZIP-reassignment count + reassures that past estimates keep their snapshotted prices (estimates have no FK to price_lists). FK `ON DELETE CASCADE` handles blocks/items/zips |
| Native photo upload fails (storage RLS) | **Fixed** (dev+prod, 2026-06-03, migration `0011`) | Root cause confirmed: `estimate-photos` policies granted **anon only**, so a logged-in (magic-link) user's request — role `authenticated` — was denied on both `createSignedUrl` (cover *display* → 400, broken thumbnails) and `upload` (INSERT → "new row violates RLS"). Migration `0011_storage_authenticated_estimate_photos.sql` widens all three policies (SELECT/INSERT/DELETE) to `anon, authenticated`. Verified on dev with a real authenticated token (upload/sign/delete all 200), then applied to prod (policies confirmed `{anon,authenticated}`). Bucket-scoped only; per-franchise *path* scoping still deferred (Phase 3 §8). The session-less anon `storageClient` workaround (index.html:4323) is now redundant but harmless |
| Native service-area boundary (decision) | **Decided: keep catch-all** (owner, 2026-06-03) | `crewlogic-pricing` intentionally falls back to the **Default** list for any unassigned ZIP (SPEC-001), so every ZIP returns a price. Owner confirmed the default catch-all behavior is fine — no service-area boundary needed. (Revisit only if native onboarding surfaces a need.) |

---

_Convention: keep this file terse. One row per project. Link to the spec for detail. Stamp **Last
verified** whenever you confirm a row against reality._
