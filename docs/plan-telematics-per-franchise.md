# Plan — Per-Franchise Telematics ("Where Are My Trucks?")

**Status:** Awaiting Owner sign-off (2026-06-12). No code until approved.
**Tracking:** `.HUB/Hub.md` → "Where are my trucks?" row.
**Supersedes:** Phase 1 (built + held on dev, v5.31.0 — hardcoded `provider=linxup`).

## Goal
Each franchise/owner connects their **own** telematics account so the "Where Are My
Trucks?" home feature shows **their** live fleet. A per-franchise **provider flag** drives
which credential is used, which API is called, and which setup instructions are shown.
Owner-only setup. (Owner's own fleet is on **Motive**; the Linxup test account is inactive.)

## Provider flag — one per franchise, either/or
- `provider` per franchise: **`motive`** | **`linxup`**. Exactly one active at a time.
- Drives: credential selection · which API to call · which setup steps to display.
- Rare dual/migration case (a franchisee on both, or mid-switch) is a **future extension** —
  the table allows >1 row per franchise, but the UI/logic assume a single active provider now.

## Data model
- New table **`telematics_credentials`** (per franchise):
  `franchise_id` (FK) · `provider` ('motive'|'linxup') · Vault secret **reference** (key/token
  stored in Supabase **Vault** — never plaintext, never sent to the client) · `status` /
  `last_validated_at` · `last_truck_count` · timestamps. Mirrors the `vonigo_credentials` pattern.
- RLS: franchise-scoped; owner-only writes; client never reads the secret.

## Settings → "Trucks" tab (owner-only)
- **Provider selector (Motive | Linxup)** — the flag.
- **Key/token input** (paste) + **flag-driven instructions:**
  - **Motive:** bottom-left **person icon** → **Developers** → **API Access** →
    **Request API key** (or copy an Active key) → paste here. *(key = UUID, e.g. `e16fdabb-…`)*
  - **Linxup:** top-bar **Setup** (gear) → **API/Developers** → ensure **API Version 2** →
    **Create New API Token** → copy → paste here. *(token = JWT, `eyJ…`)*
- **Save → validate:** server stores the key in Vault, then does a **live test call** →
  shows **"Connected ✓ — N trucks found"** or a clear error. Estimators can't see/edit.

## Edge functions
- **`crewlogic-trucks`:** resolve the franchise's `provider` + creds from Vault per request →
  call Motive (`x-api-key`) or Linxup (`Bearer`) → normalized `trucks[]`. Keep the `?provider=`
  override for testing; default to the franchise flag.
- **Save/validate fn** (new, or extend): write creds to Vault + run the validation call.
  Mirror `saveVonigoCredentials` (service role, Vault).

## Frontend
- Trucks **home tile** shows for any franchise with configured + validated telematics
  (replaces the Phase-1 `#90`-only gate).
- Trucks **screen** uses the franchise's provider — so #90 pulls **Motive** (live fleet).

## Legacy / global keys
- Existing global **`MOTIVE_API_KEY`** left **untouched** — the legacy Route Optimizer reads
  it; don't risk breaking it.
- Global **`LINXUP_API_KEY`** test secret **retired** after this lands.
- #90 connects via the per-franchise system (`provider=motive`) like everyone else.

## Decisions captured (Owner, 2026-06-12)
1. One provider per franchise (either/or). 2. Owners paste their own key/token (with
instructions). 3. Owner-only, new "Trucks"/"Telematics" Settings tab. 4. Validate on save.
5. Don't migrate the legacy Route Optimizer; route the new feature (incl. #90) through the
per-franchise system; retire the global Linxup test key. 6. Don't promote Phase 1 (Linxup-only).

## Build order (after sign-off)
1. Migration: `telematics_credentials` table + RLS (dev first). 2. Save/validate edge fn.
3. `crewlogic-trucks` per-franchise resolution. 4. Settings "Trucks" tab (flag + instructions +
save/validate UI). 5. Frontend tile/gate uses franchise provider. 6. Validate end-to-end on
dev with **Motive** (owner's live trucks) → promote (RED).

## Update log
- **2026-06-12 — BUILT on dev (v5.32.0):** all of steps 1–5 above. Owner validated Motive
  connect end-to-end on dev (trucks render).
- **2026-06-12 — UI polish (v5.32.1):** numbered truck markers ↔ numbered list rows, larger
  map, rich Motive popups (confirmed Motive v1 returns speed/bearing/located_at/description/
  make/model/year/vin via a live #90 pull).
- **2026-06-12 — Jobs-on-map (v5.33.0):** today's OPEN jobs (Vonigo, `!isComplete`) overlaid
  as 🏠 markers. Addresses geocoded via the FREE **US Census Geocoder** (no Google, no key),
  cached in `geocode_cache` (migration `0019`). `crewlogic-todays-workorders` gained
  `includeCoords`. Archived/completed jobs hidden.
- **2026-06-12 — DEFERRED (owner decision):** harden `crewlogic-trucks` caller-verification.
  Blocked for Google-OAuth owners (no Supabase JWT per-request); **folded into the future
  unified-auth work** so it covers everyone at once. Residual risk low (needs a victim's
  random internal franchise UUID + the public anon key). Tracked in `.HUB/Hub.md`.
- **Pending:** owner finishes dev validation → promote the whole feature to prod (RED, gated).
