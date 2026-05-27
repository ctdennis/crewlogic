# CL-SPEC-001 — Stage A: Native Pricing + Customers (no-CRM)

Status: **Approved to build** (2026-05-27). Builds on `CL-BRD-002` (provider abstraction) and
`D0-findings` (price-lookup response shape). Implemented + tested on the dev `none` tenant first.

## 1. Scope
Make a no-CRM company able to **configure its own pricing** and **produce priced AI estimates +
proposals** with no external CRM/order system. Two deliverables: a **native price book** and a
**native customers** store, plus the **provider seam** that selects native vs external per capability.

Out of scope here: National Accounts / negotiated tiers (dropped — see §9), Vonigo "zones"
(dropped), scheduling/work-orders (later phase), HubSpot/Salesforce integrations (future providers),
and SEC-1 auth/RLS (parallel track, gates go-live not features).

## 2. Guiding invariant (why the frontend barely changes)
The native pricing API returns the **identical JSON shape** as `crewlogic-price-lookup` (per D0):
```
{ success, zipCode, priceListID, priceListName, blocks: [
    { priceBlockID, name, sequence, items: [ { priceItemID, name, value, unitOfMeasure, sequence } ] } ] }
```
So `findVolumeItem`, `matchSurchargeItem`, `calcVolumePrice*`, the AI flow, and PDF are **untouched**.
Only the *source* of the data swaps. Decimal behavior stays derived frontend-side from
`unitOfMeasure` (D0) — no `is_allow_decimals` needed.

## 3. Architecture — per-capability provider seam
Replace a single `crm_provider` flag with **per-capability** resolution (a tenant can mix systems,
e.g. HubSpot customers + native pricing; or swap Vonigo→Salesforce for one capability):

| Capability | Values | Stage A |
|---|---|---|
| `pricing_source` | `native` \| `vonigo` | **native** for `none`; `vonigo` unchanged |
| `customer_source` | `native` \| `vonigo` \| `hubspot` \| `salesforce` | **native** for `none` |
| `submission_target` | `none` \| `vonigo` | **none** for `none` |

Stored per tenant. Each capability's edge function branches on its own value. Stage A implements
only the `native` paths; other providers slot into a single capability later without a rewrite.

## 4. Data model (new Supabase tables; built in dev first)
```sql
price_lists (
  id uuid pk default gen_random_uuid(), franchise_id uuid not null,
  name text not null, is_default boolean not null default false,
  created_at timestamptz default now(), updated_at timestamptz default now()
);  -- exactly one is_default=true per franchise (enforced in app + a partial unique index)

price_blocks (
  id uuid pk default gen_random_uuid(), price_list_id uuid not null references price_lists(id) on delete cascade,
  name text not null, block_type text not null,   -- 'volume' | 'surcharge' | 'labor' | 'single_item'
  sequence int not null default 0
);

price_items (
  id uuid pk default gen_random_uuid(), price_block_id uuid not null references price_blocks(id) on delete cascade,
  name text not null, value numeric not null,
  unit_of_measure text,            -- drives frontend decimal behavior (volume/hour/etc.)
  fraction_value numeric,          -- 0.25/0.5/… for volume tiers; null otherwise
  sequence int not null default 0, is_active boolean not null default true
);

-- zip → price list (ONE list per zip). Any zip NOT here is served by the default list.
price_list_zips (
  franchise_id uuid not null, zip text not null,
  price_list_id uuid not null references price_lists(id) on delete cascade,
  primary key (franchise_id, zip)
);

-- lean, integration-ready customers — NOT a CRM (no leads/pipeline/forecasting)
customers (
  id uuid pk default gen_random_uuid(), franchise_id uuid not null,
  name text not null,
  type text not null default 'residential',   -- 'residential' | 'commercial' (editable via dropdown)
  address text, zip text, email text, phone text,
  source text not null default 'native',       -- 'native' | 'hubspot' | 'salesforce' | 'vonigo'
  external_id text,                             -- id in the source system (null for native)
  created_at timestamptz default now(), updated_at timestamptz default now()
);
```
(Refines `CL-BRD-002 §6`: `service_zones` → `price_list_zips` to drop "zone" naming; adds `source`
to `customers`. Per-estimate `price_book` snapshot column stays as-is.)

## 5. Native pricing function (`crewlogic-pricing`)
- Input: `{ franchiseID, zip }`. Resolve `price_list_id` = `price_list_zips[zip]` else the franchise's
  `is_default` list. Assemble `blocks`/`items` from `price_blocks`/`price_items`.
- Output: the §2 shape, byte-compatible with `crewlogic-price-lookup`.
- The frontend's `priceLookup()` calls native-or-vonigo per `pricing_source` (first wiring of the seam).

## 6. UI — price-book editor
**(a) Content editor** — per price list, CRUD the blocks/items: volume tiers ($ per ¼/½/¾/full),
single items, surcharges, labor. Keep entry fast (inline rows).

**(b) Default + zip assignment**
- Exactly one list is the **Default**. On-page text: *"Zips not assigned to a specific price list are
  priced by [Default List]. To price a zip differently, add a list and assign those zips to it."*
- Single-list company → only the default exists; zip UI hidden/moot ("all zips" case).
- Assigning zips to a non-default list: **search/filter + Select-all-filtered + bulk-paste + prefix
  (`028*`)**. Assigning a zip moves it off the default/other list (one zip → one list, enforced by PK).

## 7. UI — customers
- A customers list/screen: add/edit (name, **type dropdown residential⇄commercial**, address, zip,
  email, phone). Search/select on estimate creation.
- **CSV import + a downloadable template** (fixed column names/order to remove ambiguity).
- `source='native'` for in-app/imported; `external_id` reserved for future synced records.

## 8. `none` estimate flow + provider-gated UI
- New estimate (no Vonigo job #): enter/select **customer** + address + zip → call `crewlogic-pricing`
  → estimate exactly as today (AI analyze, volume math, surcharges) → **Finalize & Send** (existing PDF
  proposal + share/email). No "Submit to Vonigo".
- Gate UI on the per-capability values: `none` shows the price-book editor, native customer picker,
  "Finalize & Send"; hides the Vonigo credentials card, job lookup, "Submit to Vonigo".

## 9. Decisions resolved (this discovery)
- **No National Accounts / negotiated tier** — dropped (in Vonigo it just mirrors the regular list).
- **One standard price list per zip**; unassigned zips → the **default** list (with on-page guidance).
- **Customers**: lean integration-ready table, not a CRM; **CSV import + template**.
- **Per-capability provider seam** (customers / pricing / submission independent).
- **`customer.type`** single but editable (dropdown).

## 10. Build sequence (all on the dev `none` tenant first)
1. Schema (§4) → dev.
2. `crewlogic-pricing` native fn (§5) — first seam wiring; verify identical shape vs Vonigo.
3. Price-book editor UI (§6).
4. Customers table + UI + CSV import/template (§7).
5. `none` estimate creation + provider-gated UI (§8).
6. Promote to prod once verified. (SEC-1 proceeds in parallel as the go-live gate.)

## 11. Variable truck size & tier model (added 2026-05-27)
- **Truck capacity is a per-company setting** (cubic yards per full truck, default 16), in Cost
  settings (`cost_settings.truckCY`). It replaces the ~10 hardcoded `16`s (CY displays index.html
  9221/9342, PDF CY cols 12414/12452/12839/12855, cost analysis 15225, proposal CY
  18584/18600/18686/18691) and the `/480` floor-volume constant (15924). **It must also be passed to
  `crewlogic-ai`**, whose volume estimation relates cubic yards ↔ truck fraction and assumes 16 today.
  This is a tech-debt win for the existing Vonigo/Junkluggers app too (de-magic-numbers `16`).
- **Tiers ship as eighths** (Included/Minimum/1/8…Full) for now. They are **dimensionless**
  (truck-size-independent), so variable truck size needs **no** tier change — only the CY conversion.
- **Variable tier models (e.g. 1/16) are future** — Vonigo supports multiple. The data layer already
  accommodates them: `price_items.fraction_value` encodes the tier set, so different granularity =
  different items, no schema change. The hardcoded eighths to make data-driven later are the **swap
  points**: frontend `volLabelMap` / `findVolumeItem` fraction labels / volume dropdown options
  (~7703, ~9566, ~9120) and the `crewlogic-ai` volume prompt. Going fully data-driven would also add
  `fraction_value` to the pricing response (diverging slightly from the Vonigo shape) — defer until needed.
