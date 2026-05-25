# CL-BRD-002 — CrewLogicAI Standalone (No-CRM) Mode

| | |
|---|---|
| **Doc ID** | CL-BRD-002 |
| **Title** | Standalone / No-CRM Mode for non-franchise junk-removal companies |
| **Status** | Draft — planning only, no code changes |
| **Owner** | Charles Dennis |
| **Created** | 2026-05-24 |
| **Related** | CL-BRD-001 (AI Volume Feedback Loop) |
| **Branch** | `feature/standalone-mode` |

> **How to use this doc.** Sections 1–11 are the business/technical plan. **Section 12 is the
> implementation playbook** — copy-paste Claude Code prompts, one per work item, in dependency
> order. Items marked 🔍 **DISCOVERY** must be investigated before their build prompt is run; each
> has its own discovery prompt. Line numbers below come from a code sweep on 2026-05-24 and should
> be re-verified at implementation time (the app is one ~18k-line `index.html` that shifts as it's
> edited).

---

## 1. Executive summary

CrewLogicAI is today tightly coupled to the Vonigo CRM (pricing-by-zip, customer records,
scheduled jobs, and estimate submission) and to Junkluggers (OAuth domain, a hardcoded tenant
UUID, franchise-specific feature gates). The goal is to sell CrewLogicAI by subscription to
**generic junk-removal companies that have no CRM**, while keeping the existing Vonigo path
working for Junkluggers.

The approach is a **provider abstraction**: a per-tenant flag `crm_provider ∈ {vonigo, none}`.
Vonigo-coupled edge functions branch on it; the `none` path reads/writes **native Supabase data
stores** that are editable in-app (a price-book editor being the centerpiece). The guiding
principle is to **preserve the data shapes the frontend already consumes** so `index.html` changes
stay minimal — only the *source* of data swaps, not the consuming code.

## 2. Background & problem statement

Vonigo serves two roles:

1. **Data source** (read) — pricing by zip, customers, scheduled work orders.
2. **Submission target** (write) — "Submit to Vonigo" pushes the finished estimate as a quote.

For a standalone company, role #2 mostly disappears (a finished estimate becomes a *sent
proposal*, not a CRM record), and role #1 must be replaced by native, in-app-managed data. The
user's canonical example: *Vonigo holds our pricing by zip code; a no-CRM company needs a way to
load/store that pricing inside the app.*

## 3. Goals / non-goals

**Goals**
- A company with no CRM can sign up, configure pricing, and produce priced AI-assisted estimates + proposals.
- Vonigo customers are unaffected (their path stays intact).
- Subscription gating drives access.

**Non-goals (this BRD)**
- Replacing Vonigo for Junkluggers.
- Importing/syncing with third-party CRMs other than Vonigo.
- A full dispatch/scheduling product (native scheduling is Phase 3, scoped but not detailed here).

## 4. Current-state Vonigo / Junkluggers dependency map

Confirmed by code sweep (2026-05-24). Line numbers approximate.

**Pricing (highest priority to replace)**
- `priceLookup()` — `index.html:~3336`; calls `crewlogic-price-lookup` edge function.
- `crewlogic-price-lookup/index.ts` — logs into Vonigo, fetches `/data/priceLists` (Method 2 + Method 3), groups into blocks. Hardcoded `junkluggers.vonigo.com/api/v1` (~line 51) and tenant UUID (~line 50).
- Frontend consumes a fixed shape: `priceBlocks` global; `findVolumeItem(fraction)` (`~9340`), `matchSurchargeItem(name)` (`~7752`), `calcVolumePrice()` (`~9542`), `calcVolumePriceSplit()` (`~9565`). **These must keep working unchanged.**
- Per-estimate price snapshot persisted (`price_book` column) — keep.
- Customer (negotiated) price lists: `customer_price_lists` table (already Supabase); `CPL_CATEGORIES` (`~4103`), discount application (`~4018`). Linked to `vonigo_client_id`.

**Vonigo option-ID mappings (submission only)**
- dwellingType→optionID and parkingType→optionID maps `index.html:~10644-10674`; jobType (`~10593`); line-item fieldIDs 9287-9290 (`~10496-10531`); default `taxID 146`; serviceType `11`. **Irrelevant in `none` mode.**

**Client search**
- `searchVonigoClients()` (`~3806`) / `selectVonigoClient()` (`~3850`) → n8n `crewlogic-estimate` `action=searchClients` → Vonigo.

**Submission & job lookup**
- `submitEstimateToVonigo()` (`~10335`), `executeVonigoSubmit()` (`~10440`) → n8n `crewlogic-submit-quote`.
- Job lookup by Vonigo Job # `lookupEstimateJobStep1()` (`~10034`) → n8n `crewlogic-job-lookup`.
- Delete-from-CRM (`~11139-11191`) → n8n `crewlogic-estimate` `action=delete`.

**Scheduling (Phase 3)**
- `crewlogic-todays-workorders`, `crewlogic-job-plan` (Vonigo `/data/WorkOrders`); n8n `crewlogic-jobs`, `crewlogic-trucks`, `crewlogic-route`.

**Auth / tenancy / gating (Junkluggers-specific)**
- OAuth `hd: 'junkluggers.com'` — `index.html:47` and `~3588-3591`; login copy `~1035`.
- Super-admin hardcode `charles.dennis@junkluggers.com` — `~4696`.
- Tenant UUID `946a4535-aa61-45b6-a6fb-9190ff546d41` — **12 total (D0-verified):** `index.html` `3471, 3751, 4335, 4469, 5243, 5322, 17615`; edge functions `crewlogic-price-lookup:50`, `crewlogic-todays-workorders:42`, `crewlogic-job-plan:44`, `crewlogic-settings:155 (REFERENCE_TENANT_ID)`, `crewlogic-settings:349 (JUNKLUGGERS_TENANT_ID)`.
- Paywall gating — `showApp()` `~4762`; statuses `active/trialing/tester/pro/enterprise`.
- Feature gate to franchise `#90` (route optimizer) — `~4806, 4968`.
- `N8N_BASE` — `index.html:3317`.

**Already CRM-independent (no work)**: AI analysis (`crewlogic-ai`), distance/route math (`calcDistances`), Street View, PDF generation, photo upload, yard-signs game, branding/settings (`franchises.cost_settings`).

## 5. Target architecture — provider abstraction

- Add `tenants.crm_provider TEXT NOT NULL DEFAULT 'none'` (`'vonigo' | 'none'`).
- Each Vonigo-coupled edge function gets a top-level branch:
  ```
  provider = lookup tenant.crm_provider
  if provider === 'vonigo' → existing Vonigo path (unchanged)
  else                     → native path: read/write Supabase, RETURN THE SAME SHAPE
  ```
- Frontend reads `currentUser.crmProvider` to toggle UI affordances (e.g. "Submit to Vonigo"
  vs "Finalize & Send"; show/hide the Vonigo credentials card; show the native pricing editor).
- **Invariant (D0-verified shape):** the JSON shape returned by `crewlogic-price-lookup` is
  `{ success, zipCode, zoneID, priceListID, priceListName, zoneName, blocks: [{ priceBlockID, name,
  sequence, items: [{ priceItemID, name, value, unitOfMeasure, sequence }] }] }`. Item objects carry
  **only** those 5 fields — `isActive` is a server-side filter (not returned) and `isAllowDecimals`
  is **not** in the response (decimal behavior is derived frontend-side from `unitOfMeasure`; see §6).
  This shape is identical across providers, so `findVolumeItem`/`matchSurchargeItem`/`calcVolumePrice*`
  are untouched. See `D0-findings.md §2`.

## 6. Data model additions (new Supabase tables)

```sql
price_lists   (id uuid pk, franchise_id uuid, name text, is_default bool, created_at timestamptz)
price_blocks  (id uuid pk, price_list_id uuid fk, name text, sequence int,
               block_type text)  -- 'volume' | 'surcharge' | 'labor' | 'single_item'
price_items   (id uuid pk, price_block_id uuid fk, name text, value numeric,
               unit_of_measure text, sequence int, is_active bool default true,
               fraction_value numeric null)  -- e.g. 0.5 for "1/2 Truckload"; null for surcharges
               -- NOTE (D0): no is_allow_decimals column needed for parity. The frontend derives
               -- decimals from unit_of_measure ∈ {cubic yards, volume, hour, flight, pound}
               -- (index.html DECIMAL_ALLOWED_UNITS). Seed volume tiers with a decimal-allowed unit
               -- (e.g. 'volume') and per-piece surcharges with a non-decimal unit (e.g. 'ea').
service_zones (id uuid pk, franchise_id uuid, zip_code text, price_list_id uuid fk)
customers     (id uuid pk, franchise_id uuid, name text, address text, zip text,
               email text, phone text, external_id text null, created_at timestamptz)
```

- `price_items.id` is the native `priceItemID` (frontend keys on ID, never name).
- `fraction_value` lets the native lookup label volume tiers so `findVolumeItem()` matching survives.
- Generalize `customer_price_lists.vonigo_client_id` → nullable `customer_id uuid` (keep old column during migration).
- RLS on all new tables scoped by `franchise_id` (and tenant via join). 🔍 confirm existing RLS pattern.

## 7. Feature requirements (standalone path)

1. **Native price book** — tables above; **starter template seed** (Minimum→Full volume tiers +
   common surcharges: Mattress/Box Spring, TV/Monitor, E-waste, Freon, Tire, Paint, Shredding).
2. **In-app Pricing editor** (Settings) — CRUD for price lists/blocks/items + a zip→price-list map.
3. **Native price lookup** — `crewlogic-price-lookup` `none` branch: zip → `service_zones` →
   `price_list` → blocks (existing shape).
4. **Native customers + search** — `customers` table; in-app add/search replacing the Vonigo box;
   populate the same `selectedClient*` fields.
5. **Finalize & Send** — replaces "Submit to Vonigo" in `none` mode: generate existing PDF, email
   to customer / share link, set estimate `status='sent'`. New `crewlogic-send-proposal` edge fn.
6. **Scheduling features** — Phase 3; hidden for `none` tenants in MVP.

## 8. Auth / tenancy / onboarding / billing

- Drop `hd:'junkluggers.com'` for non-invite sign-ins; update login copy.
- **Self-serve provisioning** in `crewlogic-oauth-callback`: no profile + no invite →
  create `tenant(crm_provider='none') → franchise → owner profile → default seeded price_list`,
  instead of `auth_error=no_account`.
- Remove all hardcoded tenant UUIDs → always `currentUser.tenantID`.
- **Billing**: integrate Stripe (assumed) to write `tenants.subscription_status`; existing paywall consumes it.
- De-hardcode super-admin and the `#90` feature gates → role / `subscription_tier` / feature-flag table.

## 9. Phasing

- **Phase 0 — De-hardcode (enabler).** Provider flag; remove tenant UUID + OAuth domain restriction. No user-visible change; unblocks all else.
- **Phase 1 — MVP standalone estimating.** Native price book + editor + zip map + native lookup. A no-CRM company can estimate and price.
- **Phase 2 — Customers, proposal delivery, self-serve signup, billing.**
- **Phase 3 — Native scheduling.** Jobs model to revive work orders / job plan / routes for `none` tenants.

## 10. Risks

- **Production-only environment.** This touches auth + provisioning live. Strongly recommend standing up the planned dev/prod split *before* Phase 0.
- **One-file frontend.** Repeated UI patterns; line-anchored edits required. The shape-preserving design keeps the blast radius small.
- **Pricing snapshot correctness.** Native edits must not retroactively change historical estimates (the per-estimate `price_book` snapshot already protects this — verify it's populated on the native path too).
- **RLS gaps** on new tables could leak cross-tenant data — must be reviewed (security-review skill).
- 🔒 **Pre-existing permissive RLS (D0-confirmed).** The existing tables (`profiles`, `franchises`,
  `tenants`, `estimates`, `customer_price_lists`) have RLS enabled but **fully permissive policies**
  (`USING (true)`, role `public`); isolation is enforced only in app code today. This is a serious
  cross-tenant leak risk once multiple unrelated companies share the database. **Remediation track
  SEC-1** (below) must close this before any non-Junkluggers tenant is onboarded.

## 11. Open decisions

1. Standalone scheduling: hide in MVP (recommended) vs build native jobs sooner.
2. Billing provider: Stripe assumed — confirm.
3. Dev/prod split before Phase 0: strongly recommended — confirm sequencing.
4. Starter price-book template: generic rate card vs empty.

---

## 12. Implementation playbook — Claude Code prompts

Run in order; each phase depends on the prior. **Before each build prompt**, run any 🔍 discovery
prompt in that section. Recommended habits baked into prompts: start read-only/plan, preserve data
shapes, test edge functions against the deployed URL before committing, and diff the repo source
against what's deployed before any `supabase functions deploy` (lesson learned: the repo can lag prod).

### 🔍 DISCOVERY D0 — Baseline & RLS audit (run first)
```
Read-only investigation, no changes. I'm starting the Standalone/No-CRM project
(docs/Feature-StandaloneMode/CL-BRD-002). Confirm and report, with file:line:
1) Re-verify every reference listed in CL-BRD-002 §4 still exists and report the CURRENT line
   numbers (the file has shifted): OAuth hd restriction, super-admin check, all hardcoded tenant
   UUID 946a4535-… occurrences, paywall gating in showApp, franchise #90 feature gates, N8N_BASE.
2) Inspect the Supabase schema for existing RLS policies on profiles, franchises, tenants,
   estimates, customer_price_lists — summarize the tenancy scoping pattern so new tables match it.
   (Use the Supabase SQL editor approach noted in CLAUDE.md; if you can't reach the DB, say so and
   list exactly what I need to pull.)
3) Confirm how the deployed crewlogic-price-lookup response is shaped by capturing one real
   response (or reading the edge function), and document the exact JSON the frontend consumes.
Produce a short findings doc; do not edit code.
```

### Phase 0 — De-hardcode (enabler)

**P0.1 — Provider flag + remove tenant hardcoding**
```
Plan first, then implement. Add multi-tenant provider support without changing behavior for
existing Junkluggers/Vonigo users.
- Add column tenants.crm_provider text not null default 'none' (give me the SQL migration; I'll run
  it in the Supabase SQL editor). Backfill the Junkluggers tenant (946a4535-…) to 'vonigo'.
- In index.html, replace every hardcoded tenant UUID (see CL-BRD-002 §4 / discovery D0 current
  line numbers) with currentUser.tenantID; keep a single defined constant only as an
  explicit fallback for the Junkluggers tenant, clearly commented.
- Plumb crm_provider through crewlogic-oauth-callback into the session and set
  currentUser.crmProvider on login.
- Do NOT change any user-visible behavior yet. Verify Junkluggers login still resolves tenant/
  franchise correctly. Diff repo vs deployed for any edge function before deploying.
```

**P0.2 — Open the OAuth domain restriction**
```
Plan first. Allow non-junkluggers Google accounts to authenticate while preserving the existing
direct-sign-in experience for Junkluggers.
- Make the hd:'junkluggers.com' OAuth param conditional/configurable rather than hardcoded
  (it already lifts for invite flows — generalize that). Update the login screen copy that says
  "@junkluggers.com".
- This step ONLY changes who can reach the OAuth callback; provisioning for brand-new companies is
  handled in P2.1, so a new account with no profile/invite should still land on the existing
  no_account path for now. Confirm that's what happens.
```

### Phase 1 — MVP standalone estimating

**P1.1 — Native pricing schema + seed template**
```
Plan first. Create the native price-book data model from CL-BRD-002 §6 (price_lists, price_blocks,
price_items, service_zones). Provide:
- SQL migrations (tables + indexes + RLS scoped by franchise_id, matching the pattern from
  discovery D0). I will run them in the Supabase SQL editor.
- A seed routine that creates a default price_list for a franchise with the standard volume tiers
  (Minimum, 1/8, 1/4, 3/8, 1/2, 5/8, 3/4, 7/8, Full with fraction_value set) and the common
  surcharge items (Mattress/Box Spring, TV/Monitor, E-waste, Freon, Tire, Paint, Shredding),
  prices left at 0 for the owner to fill in. Document the seed as idempotent.
No frontend yet.
```

**P1.2 — Native branch in crewlogic-price-lookup**
```
Plan first. Add a provider branch to crewlogic-price-lookup. For crm_provider='none', given
{ franchiseID, zipCode }, resolve service_zones → price_list → blocks and return the EXACT same
JSON shape the Vonigo path returns (D0-verified — block: { priceBlockID, name, sequence, items[] },
items: { priceItemID, name, value, unitOfMeasure, sequence } ONLY; no isActive/isAllowDecimals in the
response — see D0-findings §2). NOTE: §14 supersedes this with a NEW function (S-A.3); prefer that.
The Vonigo path must
remain byte-for-byte unchanged. Before deploying: diff repo source vs deployed function. After
deploying: test BOTH a native franchise (returns seeded blocks) and confirm the response shape
matches what findVolumeItem()/matchSurchargeItem() expect. Return results; commit only after tests pass.
```

**P1.3 — In-app pricing editor (Settings)** 🔍 see D1 first
```
Plan first, then implement in index.html following existing screen/render conventions (register the
new screen in allScreens; use show*/render* naming; match CSS variables, no hardcoded colors).
Build a Pricing editor under Settings for crm_provider='none' tenants only:
- List/create/rename/delete price lists; mark one default.
- Within a list: CRUD price blocks (with block_type) and price items (name, value, unit, decimals).
- A zip→price-list mapping screen writing service_zones.
- All reads/writes via supabaseFetch (not direct fetch). Scope every query by currentUser.franchiseID.
Hide this entire editor for crm_provider='vonigo'. Verify a created/edited price book is returned
correctly by the P1.2 native lookup end to end (enter a zip mapped to the list, confirm priceBlocks
populates and a volume estimate prices correctly).
```

**🔍 DISCOVERY D1 — Settings screen integration**
```
Read-only. Document how the Settings screen is structured in index.html: the tab system
(showSettingsTab), how existing settings cards are laid out, how allScreens registration works, and
where the Vonigo credentials card lives (so I can conditionally hide it). Report file:line and the
minimal integration points for adding a new "Pricing" settings area. No changes.
```

### Phase 2 — Customers, delivery, signup, billing

**P2.1 — Self-serve provisioning**
```
Plan first. In crewlogic-oauth-callback, when a Google sign-in has no profile AND no invite token,
provision a new standalone account instead of returning auth_error=no_account:
create tenant(crm_provider='none') → franchise → owner profile (role owner) → default seeded
price_list (reuse P1.1 seed). Wrap in a transaction/RPC; handle the email-already-exists race.
Keep the existing behavior for Junkluggers direct sign-ins and invite flows. Provide SQL for any
RPC. Test the new-account path end to end against the deployed callback; confirm the session
returns crmProvider='none' and the app loads to an (empty-but-seeded) pricing state, not the paywall
inadvertently. Diff repo vs deployed before deploying.
```

**P2.2 — Native customers + search**
```
Plan first. Add the customers table (CL-BRD-002 §6) + RLS. Replace the "Search Vonigo Client" UI
for crm_provider='none' with a native add/search backed by customers (via supabaseFetch), populating
the same selectedClientID/Name/Address/Zip fields the estimate flow already uses, so downstream code
is unchanged. Generalize customer_price_lists to a nullable customer_id FK (keep vonigo_client_id for
Vonigo tenants). Keep the Vonigo search path intact for vonigo tenants.
```

**P2.3 — Finalize & Send proposal**
```
Plan first. For crm_provider='none', replace the "Submit to Vonigo" action with "Finalize & Send
Proposal": reuse the existing PDF generation, add a crewlogic-send-proposal edge function that emails
the PDF to the customer (or returns a shareable link), and set the estimate status to 'sent'. No
Vonigo option-ID/fieldID mapping on this path. Vonigo submission stays for vonigo tenants. Decide and
document the email transport (🔍 discovery: what email service is available/configured).
```

**P2.4 — Billing / paywall**
```
Plan first. Integrate Stripe (confirm provider) so subscription lifecycle writes
tenants.subscription_status. The existing paywall in showApp already gates on status — wire a
webhook (edge function) to update status on checkout/renewal/cancel. De-hardcode the super-admin
check and the franchise #90 feature gates to use role / subscription_tier / a feature_flags table.
Provide SQL + the webhook function; test with Stripe test mode before any production keys.
```

### Phase 3 — Native scheduling (scoped, not detailed)

**P3.0 — 🔍 DISCOVERY: native scheduling shape**
```
Read-only. Document exactly what data crewlogic-todays-workorders and crewlogic-job-plan consume and
return, and what the route optimizer / trucks features need. Propose a minimal native `jobs` schema
that could feed these same shapes for crm_provider='none' tenants. No changes — output a mini-BRD
addendum I can fold into CL-BRD-002.
```

---

## 13. Appendix — guardrails for every implementation prompt

- Start read-only / in plan mode; get the plan approved before editing.
- Preserve data shapes consumed by `index.html`; the provider swap must be invisible to consuming code.
- Scope all Supabase queries by `currentUser.franchiseID` / tenant; never widen scope.
- For edge functions: **diff repo source vs the deployed version before `supabase functions deploy`**, and test against the deployed URL (transcript/base64/URL-style cases as applicable) before committing.
- Run the `security-review` skill on any change touching auth, RLS, or new tables.
- Bump edge-function internal version headers and the `index.html` version (`<meta>` + `_FEEDBACK_APP_VERSION`) per CLAUDE.md when shipping user-visible changes.

---

## 14. Low-impact build sequence (recommended execution order)

This section re-sequences §9/§12 around an **additive-first** axis: build the standalone stack as
*new* objects that the live Vonigo/Junkluggers path never touches, prove it in isolation, and defer
the few unavoidable shared-surface changes to the end behind a flag. It supersedes §9 phasing as the
**preferred order of operations**; the §12 prompts still apply, with the variations noted here.

### 14.1 Shared vs. net-new surfaces

| Surface | Shared with prod? | Mitigation |
|---|---|---|
| New tables (`price_lists`, `price_blocks`, `price_items`, `service_zones`, `customers`) | No — net-new | Adding tables cannot affect existing queries |
| `tenants.crm_provider` column | Touches existing table | Add with **`DEFAULT 'vonigo'`** so every existing tenant reads as Vonigo; only new standalone tenants are set `'none'` |
| Native pricing edge function | No — net-new | Stand up a **separate** function (e.g. `crewlogic-pricing`); do **not** branch inside `crewlogic-price-lookup` |
| `crewlogic-oauth-callback` (provisioning) | Shared | Defer to Stage C; until then create test/pilot tenants by hand |
| `index.html` (live app) | Shared | Defer to Stage B; gate every new line behind `crmProvider === 'none'` (dead code for current users) |

> **Key design change vs. §12:** the native lookup is a **new function**, not a branch in
> `crewlogic-price-lookup`. This keeps the deployed Vonigo function byte-for-byte untouched. The
> branch-inside approach in P1.2 is replaced by S-A.3 below.

### 14.2 Stage A — Backend only, zero production impact

No `index.html` edits; no changes to existing edge functions or in-use tables. Fully reversible
(drop the new tables + delete the new function). **Exit criteria:** a test tenant can create/edit a
price book and look it up by zip via API, returning the shape the frontend expects — production
untouched.

**S-A.1 — New tables + RLS**
```
Plan first. Create the native price-book + customers schema from CL-BRD-002 §6 as PURELY ADDITIVE
objects: price_lists, price_blocks, price_items, service_zones, customers. Provide SQL migrations
with PROPERLY SCOPED RLS. IMPORTANT: do NOT copy the existing tables' RLS pattern — D0 found those
policies are fully permissive (USING (true), role public, no franchise/tenant scoping; see
D0-findings §3). Instead write policies that restrict each row to the caller's franchise, e.g. via a
join: franchise_id IN (select franchise_id from profiles where auth_user_id = auth.uid()). Do NOT
alter any existing table or query. I will run the SQL in the Supabase SQL editor. Output the
migration as a numbered file I can also keep under a future migrations/ folder.
```

**S-A.2 — Provider column (safe default)**
```
Plan first. Add tenants.crm_provider text not null default 'vonigo'. Because the default is
'vonigo', every existing tenant (incl. Junkluggers) keeps current behavior with no backfill needed;
only new standalone tenants will be set to 'none'. Give me the one-line migration. Do not change any
code that reads tenants yet.
```

**S-A.3 — New native pricing edge function (replaces P1.2 branch approach)**
```
Plan first. Create a NEW edge function crewlogic-pricing (do not modify crewlogic-price-lookup).
It handles, for crm_provider='none' franchises:
  - CRUD for price_lists / price_blocks / price_items / service_zones (via service role + RLS-safe
    franchise scoping),
  - a lookup action { franchiseID, zipCode } that resolves service_zones → price_list → blocks and
    returns the EXACT JSON shape crewlogic-price-lookup returns (D0-verified, see D0-findings §2):
    { success, zipCode, zoneID, priceListID, priceListName, zoneName,
      blocks: [{ priceBlockID, name, sequence,
                 items: [{ priceItemID, name, value, unitOfMeasure, sequence }] }] }.
    Item objects carry ONLY those 5 fields — do NOT add isActive/isAllowDecimals to the response.
Include the idempotent default-price-book seed (volume tiers Minimum→Full with fraction_value and a
decimal-allowed unit_of_measure such as 'volume'; standard surcharges with a non-decimal unit such as
'ea'; prices 0). Decimal behavior is driven entirely by unit_of_measure (DECIMAL_ALLOWED_UNITS =
{cubic yards, volume, hour, flight, pound}), so set units deliberately. Deploy as a new function
(zero risk to existing ones). Do not touch index.html.
```

**S-A.4 — Test tenant + end-to-end API validation**
```
Read/created-data only — no app changes. Create a TEST tenant (crm_provider='none') + franchise +
owner profile + seeded price book + one mapped zip, via SQL/API. Then validate crewlogic-pricing
end to end with curl: create/edit an item, then run the lookup for that franchise+zip and assert the
returned JSON matches the documented price-lookup shape field-for-field. Report the curl commands and
results. Confirm production (Junkluggers) is untouched by re-running a normal crewlogic-price-lookup
call and showing it is unchanged.
```

### 14.3 Stage B — Minimal gated frontend

Now the unavoidable `index.html` work, defensively. Every addition is dead code for current users
(`crmProvider === 'vonigo'`).

**S-B.1 — Route price lookup by provider (gated)**
```
Plan first. In index.html, make priceLookup() call the new crewlogic-pricing function ONLY when
currentUser.crmProvider === 'none'; the existing Vonigo call path stays byte-for-byte unchanged for
everyone else. Since the response shapes are identical (verified in Stage A), no downstream consumer
(findVolumeItem / matchSurchargeItem / calcVolumePrice*) changes. Smoke-test that a vonigo user's
lookup is unaffected.
```

**S-B.2 — Gated pricing editor (was P1.3 + D1)**
```
Plan first. Run discovery D1 (Settings screen structure) if not already done. Build the Pricing
editor under Settings, the ENTIRE thing wrapped so it only renders/initializes when
currentUser.crmProvider === 'none'. Register the screen in allScreens; use show*/render* naming and
existing CSS variables. CRUD price lists/blocks/items + a zip→price-list map, all via crewlogic-pricing
(or supabaseFetch). Confirm a vonigo user sees zero change anywhere in Settings.
```

### 14.4 Stage C — Provisioning & access (last, most coupled)

Touches shared surfaces (`crewlogic-oauth-callback`, paywall). Do only after Stages A–B are proven.
Until then, onboard pilot companies by hand-creating their tenant (the Stage A path).

- 🔒 **S-C.0 (SEC-1, HARD GATE) — tighten existing RLS before ANY non-Junkluggers tenant exists.**
  See `SEC-1-supabaseFetch-audit.md` for the full 80-call inventory. **Key constraint:** `supabaseFetch`
  sends only the anon key (no per-user JWT), so `auth.uid()` is null on every browser→PostgREST call —
  an `auth.uid()`-based policy would break all 80 calls. SEC-1 therefore STARTS with an
  auth-architecture decision (A: adopt Supabase Auth / B: edge-function gateway / C: custom signed JWT;
  recommend A), then:
  ```
  Plan first; treat as a security change (security-review skill + regression pass over all 80 call
  sites, ideally in a dev environment).
  1. Implement the chosen auth approach so the DB can identify the caller's franchise/tenant
     (Option A: OAuth callback mints a real Supabase session; supabaseFetch sends the user JWT as
     bearer — response shapes unchanged, so the change is per-header not per-query).
  2. Replace the permissive policies on profiles/franchises/tenants/estimates/customer_price_lists
     AND the new standalone tables with franchise/tenant-scoped policies. Verify row-id writes
     (PATCH/DELETE ?id=eq.X) are REJECTED when the row is outside the caller's franchise.
  3. Fix the 10 UNSCOPED calls listed in the audit §3.2.
  No second tenant may be onboarded until 1–3 are live and verified.
  ```
- **S-C.1** = P2.1 self-serve provisioning (now low-risk: the native stack it provisions into is proven).
- **S-C.2** = P2.4 billing/paywall + de-hardcode super-admin and `#90` gates.
- **S-C.3** = P2.2 native customers UI + P2.3 Finalize & Send proposal.

### 14.5 Why this order is safe

- Stage A is 100% reversible and invisible to production — you can stop after it with nothing to undo.
- The riskiest, shared-surface work (Stage C) sits on top of a proven foundation, so pricing logic
  and auth/provisioning are never being debugged simultaneously.
- A working standalone pricing flow is demoable via API (or a throwaway test page) **before** any
  production frontend edit.
