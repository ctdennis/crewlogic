# Plan — Consolidated Telematics Setup (Motive + Linxup, API + Webhook)

Status: DRAFT — awaiting Owner approval
Owner: charles.dennis@junkluggers.com
Author: Claude (master session)
Date: 2026-07-04
Related: `docs/PushAPIV3.pdf`, `docs/LinxupPushAPI.pdf`, Linxup pull-API swagger `api.linxup.com/pullapi/swagger-ui`

## Goal

Reorganize **Settings → Trucks** into two provider **expanders — Motive and Linxup** — each with an **API (pull)** section and a **Webhook (push)** section, and build the missing **Linxup webhook** side (receiver + secret storage). Net effect: one clean, symmetric place to wire either telematics provider end-to-end.

## Decisions (Owner, 2026-07-04)

1. **One ACTIVE provider at a time for the fleet display**, but **credentials for BOTH providers are stored simultaneously.** Franchise #90 needs both Motive AND Linxup configured at once for testing — so saving Linxup must NOT wipe Motive. Model: per-provider credential storage + a single `is_active` "which provider feeds the trucks map" flag (activating one deactivates the other). A normal franchise configures one (it's active); #90 configures both and flips the active one to test each.
2. **All-at-once rollout** — one plan/PR: Linxup receiver + full expander reorg together (dev-first, then gated prod promote).

### Storage change implied by Decision 1 (updated from "no change")

`telematics_credentials` today is single-slot (`UNIQUE(franchise_id)`, one Vault secret `telematics_token_<fid>`). To store both providers:
- Change uniqueness `UNIQUE(franchise_id)` → `UNIQUE(franchise_id, provider)`.
- Add `is_active boolean not null default true`; exactly one active row per franchise (upsert of a provider sets its row active + others inactive).
- Per-provider Vault secret name `telematics_token_<fid>_<provider>` for NEW writes; the existing migrated row keeps its old `secret_name` column value (still valid — the name is read from the column, so no Vault migration needed). Existing rows → `is_active = true` (they're the only one; default active = Motive for #90).
- `get_telematics_credential(franchiseID)` returns the **active** row (crewlogic-trucks behavior unchanged); `get_telematics_status` returns **per-provider** status so the UI shows both expanders' pull state.
- Migration must preserve #90's LIVE Motive pull through the change (verify on dev first).

## Current state (verified)

- **Settings → Trucks** (`stab-content-trucks`, index.html ~1958) = two flat `.settings-card`s:
  - **Card A "Truck Tracking (Telematics)"** (~1959) — pull config: Motive/Linxup radio (`name="telematicsProvider"`), token field (`#telematicsToken`), Save → `saveTelematicsCredential()` (~8422) → `crewlogic-settings` action `saveTelematics` → `telematics_credentials` (one row per franchise, UNIQUE `franchise_id`) + Vault secret `telematics_token_<franchise_id>`. Consumed by `crewlogic-trucks` via RPC `get_telematics_credential`.
  - **Card B "Motive Geofence Alerts"** (~2010) — webhook config: readonly URL `#motiveWebhookUrl` (`…-motive-webhook?f=<external_id>`), secret field `#motiveWebhookSecret`, Save → `saveMotiveWebhookSecret()` (~8397) → action `saveMotiveWebhookSecret` → `motive_webhook_config` + Vault secret `motive_webhook_secret_<franchise_id>`. Consumed by `crewlogic-motive-webhook` (HMAC-SHA1, `?f=` attribution).
- **No Linxup webhook exists** anywhere (receiver, storage, or UI).

## Provider matrix (must be preserved / built to)

| | Motive | Linxup |
|---|---|---|
| Pull auth | header `x-api-key: <token>` | header `Authorization: Bearer <token>` |
| Pull endpoint | `api.gomotive.com/v2/vehicle_locations` | `app02.linxup.com/ibis/rest/api/v2/locations` |
| Webhook auth | HMAC-SHA1 sig in `x-kt-webhook-signature` (secret **Motive** gives you) | Bearer token in **`Authentication`** header (token **we** generate) |
| Webhook success code | 200 | **201** (Linxup requires) |
| Secret direction | paste FROM Motive INTO our field | we GENERATE, you paste INTO Linxup |
| Msg discriminator | Motive event types | `pushType` (flat doc) or `eventType`+nested (V3 doc) |

Note the two Linxup docs describe **two payload formats** (flat `pushType`/`fenceEventCd`/`fenceName` vs nested `eventType`/`tracker`/`geofence`). The receiver will **log-then-parse**: accept + store raw first so we confirm which format your account sends, with the parser written to handle **both**.

## Design

### 1. Storage (mirror the Motive webhook pattern for Linxup — Motive path untouched)

- **Pull:** no change. `telematics_credentials` single-slot already supports provider `motive|linxup`; "one provider at a time" matches it exactly.
- **Linxup webhook secret:** new migration mirroring `0027_motive_webhook_secret.sql`:
  - Table `public.linxup_webhook_config` (PK `franchise_id`, `secret_name`, `status`, timestamps).
  - Vault secret name `linxup_webhook_secret_<franchise_id>`.
  - RPCs `upsert_linxup_webhook_secret`, `get_linxup_webhook_secret` (receiver-only), `get_linxup_webhook_status` (service-role only).
- **Rationale:** mirroring keeps the LIVE Motive webhook path 100% untouched (zero regression risk to prod truck crossings). Consolidation is in the UI, not a risky storage merge.

### 2. New edge function `crewlogic-linxup-webhook`

- Attribution: `?f=<franchise external_id>` (same as Motive) → resolve franchise → load its Linxup webhook secret.
- Auth: verify incoming `Authentication` header == `Bearer <stored secret>`; else 401.
- Discriminate on `pushType` (flat) or `eventType`+shape (V3); parse **both** formats.
- Phase-1 behavior:
  - `FENCE_ENTER` / `FENCE_EXIT` → write a truck alert into `geofence_alerts` (reuse the Motive receiver's alert model + realtime), so it appears in your Live Alerts rail.
  - Other types (POSITION/STOP/TRIP/USAGE_HOURS/Alert/Item-Tracking) → capture/log, no action yet.
- Respond **201** on success (Linxup contract).
- Dev-first: deploy to the dev Supabase, log raw payloads so we confirm the real format against a live push before trusting the parser.

**Scope boundary (Phase-1):** Linxup fence alerts are surfaced by **fence name** (e.g. "entered Depot 1"). Full **job**-arrive/leave matching (tying a fence to a CrewLogic job) needs Linxup geofence CREATION per job — `crewlogic-geofence-create` is Motive-only today — so Linxup job-level matching is a **follow-on**, not this build.

### 3. crewlogic-settings — new actions

- `saveLinxupWebhookSecret` — **generates** a random secret server-side, stores in Vault, returns it **once** for display/copy (like an API key; re-calling rotates it). (We define the token; Owner pastes it into Linxup.)
- `getLinxupWebhookStatus` — `{ configured, updatedAt }` for the UI.
- (Motive actions unchanged.)

### 4. UI reorg — Settings → Trucks → two expanders

```
Truck Tracking (Telematics)          [ one provider active: Motive ]

▸ Motive
    API (pull)     [ x-api-key token ........ ] [Save & Test]  ✓ 6 trucks
    Webhook (push) URL:  …-motive-webhook?f=90   [copy]
                   Signing secret (from Motive) [ ........ ]   [Save]  ✓ configured

▾ Linxup
    API (pull)     [ Bearer token ........... ] [Save & Test]  — not active
    Webhook (push) URL:  …-linxup-webhook?f=90   [copy]
                   Token (we generate)  abc123…  [copy] [Regenerate]
                   → paste URL + token into Linxup's webhook page
```

- Each expander = one provider; header shows which provider is the **active pull** provider (saving an API token makes that provider active — enforces "one at a time").
- **Preserve every existing element ID + handler** (`#telematicsToken`, `saveTelematicsCredential`, `#motiveWebhookUrl`, `#motiveWebhookSecret`, `saveMotiveWebhookSecret`, `renderTrucksTab`, etc.) — the reorg re-parents them into expanders, it does not rewrite the save/load logic. New Linxup webhook controls are additive.

## Rollout (dev-first, all-at-once)

1. Migration → **dev** (`linxup_webhook_config` + RPCs).
2. Deploy `crewlogic-linxup-webhook` + updated `crewlogic-settings` → **dev**.
3. UI reorg on `dev` branch → test at `dev.crewlogic.pages.dev`; Owner pastes dev URL + token into the Linxup DEV webhook; confirm a real push authenticates + lands (this also resolves the flat-vs-V3 format question).
4. Promote: migration → **prod** (gated), deploy fns → **prod** (gated), merge `dev`→`main` (gated). Verify Motive crossings still land (regression) + a Linxup push lands.

## Regression guard (preserve, verify post-deploy)

- Motive pull (`telematics_credentials`, `crewlogic-trucks`), Motive webhook + live truck crossings (`crewlogic-motive-webhook`, `motive_webhook_config`, HMAC, `?f=`), the geofence-alerts pipeline + Live Alerts rail, all existing Trucks-tab IDs/handlers. Motive storage + receiver are **not modified**.

## Open follow-ups (not this build)

- **Motive webhook geofence-name resolution under dual-provider.** `crewlogic-motive-webhook` resolves geofence names via `get_telematics_credential` (now returns the ACTIVE provider). If Linxup is the active pull provider while Motive crossings still fire, Motive alerts still land (attribution = `?f=` + Motive secret) but names won't resolve. Fix = give the motive webhook a provider-specific credential read (`get_telematics_credential_for(fid,'motive')`) instead of the active one. Low impact; only bites the both-configured/linxup-active test state.
- Linxup job-level geofence matching (needs Linxup geofence-create per job).
- Optional: unify `motive_webhook_config` + `linxup_webhook_config` into one provider-aware table later (deferred — not worth the risk to the live Motive path now).
- Linxup pull: richer fields (odometer/fuel/engine) if the pull API exposes them (per swagger) — today Linxup pull is location-only.

## Test plan (per gate)

- [ ] Migration applies clean on dev (method: `dev-sql.sh` / migration run)
- [ ] `saveLinxupWebhookSecret` stores + returns a token once; `getLinxupWebhookStatus` reflects configured (method: API smoke on dev)
- [ ] Linxup receiver: bad/missing Bearer → 401; valid → 201 (method: curl to dev fn)
- [ ] Real Linxup DEV push authenticates + raw payload captured; format (flat vs V3) confirmed (method: Owner triggers a push; read stored raw)
- [ ] FENCE_ENTER/EXIT surfaces in Live Alerts rail (method: manual on dev)
- [ ] Motive crossings still land post-deploy (method: verify a real Motive crossing on prod after promote)
- [ ] Trucks-tab expanders render; existing Motive save/test/webhook still work (method: manual on dev)
