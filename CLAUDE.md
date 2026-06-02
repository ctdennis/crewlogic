# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Dev tooling & approval discipline (READ FIRST)

Approvals in `.claude/settings.local.json` match by **exact command prefix, one command at a time**. A pipe (`|`), redirect (`>` / `2>&1`), `;`/`&&` chain, or an **absolute path** makes a command miss its allow-rule and forces an unnecessary prompt. Therefore:

- **Run dev tooling in EXACTLY these forms** — relative path, from the repo root, **no `|`, no `>`/`2>&1`, no `;`/`&&`, no absolute paths.** Read the JSON/text output directly; if you must filter it, do that in a separate step.
  - Dev SQL (wrapper refuses unless linked to crewlogic-dev): `bash supabase/dev-setup/dev-sql.sh "<sql>"`
  - **Read-only PROD SQL** (allowlisted; refuses unless linked to prod; rejects anything but a single read statement AND runs it inside a `READ ONLY` transaction so Postgres blocks any write): `bash supabase/dev-setup/prod-readonly-sql.sh "<SELECT ...>"`. Use this for prod SELECTs instead of `supabase db query` (which stays gated, since it can also write).
  - Syntax-check index.html: `bash supabase/dev-setup/check-html.sh`
  - Deploy a function to dev: `supabase functions deploy --project-ref bagkimfwmpwjfhfhmsrb <name> --use-api --no-verify-jwt`
  - Set a dev secret: `supabase secrets set --project-ref bagkimfwmpwjfhfhmsrb KEY=VALUE`
- **Read-only inspection — don't self-inflict prompts.** The matcher reads the WHOLE command string; it decomposes simple `&&`/`;`/`|` chains, but does NOT see through **command substitution `$(...)`**, **`for`-loops**, **heredocs** (`<<'PY'`), or a **leading `VAR=...;`** assignment — those read as one opaque command and prompt even when the work is read-only. So:
  - **Prefer the Read tool for files** (never prompts on allowed paths) and a single plain Bash command otherwise. No `cd`-prefix (the working dir persists), no chains, no `$(...)`, no loops, no heredocs.
  - Find a line → `grep -n "<pat>" index.html`, then read the range with the **Read tool** (not `sed -n "$(...)"`).
  - Inspect a deployed prod edge fn → `supabase functions download <name> --project-ref ozfkpxyachigfpcmvekz --workdir /tmp/fn-reconcile --use-api`, then `diff` (read-only).
  - Heredoc one-liners (`python3 - <<'PY'` for the control-byte scan / inline-script V8 parse) are inherently un-allowlistable — use them ONLY when a check genuinely needs them, and expect the prompt.
- **Before ANY command that may prompt** (anything prod-touching, destructive, or not matching an allow-rule), FIRST write a one-line plain-English note — **What it does · what it touches (dev vs prod) · impact & reversibility** — then run it. Never fire a gated command without that line.
- **Read-only prod access is PRE-APPROVED** (owner standing approval, 2026-05-27): inspecting prod is fine without asking — e.g. `supabase functions logs ... --project-ref ozfkpxyachigfpcmvekz`, `supabase secrets list` (names/digests only), read-only `SELECT`s and `GET`s against prod (incl. via the public anon key). **Still write the one-line note first.** "Read-only" means **nothing is mutated** — no INSERT/UPDATE/DELETE, no deploy, no secret set/unset, no config change. Anything that writes to prod stays gated.
- **Always gated (do not bypass):** `git push origin main`; `supabase functions deploy` / `secrets set` / `secrets unset` with the **prod** ref `ozfkpxyachigfpcmvekz`; `supabase db push`; any prod **write**.

## What this is

CrewLogicAI is a single-page web app for The Junkluggers franchise crews/owners: AI-assisted junk-removal estimating, pricing, job planning, route/truck-load math, and a "yard signs" tracking/rewards game. **The entire application lives in one file: `index.html` (~18.4k lines).** There is no build step, no package manager, no test suite, and no framework — it is vanilla HTML/CSS/JS with CDN-loaded libraries.

## Project status — read `docs/STATUS.md` first

**`docs/STATUS.md` is the single source of truth for project / build / production-rollout status.** For any "where are we / what's done / what's shipped" question, **read that file instead of re-deriving status from the code** — re-analyzing `index.html` + the edge functions is expensive and was only necessary because the docs had drifted. Feature specs live in `docs/Feature-StandaloneMode/` and STATUS.md links to them.

Keep it current with the **check → update → recheck** protocol (also stated at the top of STATUS.md):
1. **Check** the relevant row *before* starting a change.
2. **Update** the row (Build / Prod / Version / Open items) *in the same commit* as the change — never let the tracker lag the code.
3. **Recheck** after the change landed and stamp **Last verified** with the date. If a field (e.g. prod-tenant usage) couldn't be verified, say so in Notes rather than guessing. Trust entries with a recent *Last verified*; re-verify stale ones.

## Architecture

`index.html` is structured as three sequential blocks:
- **Lines ~1–53** — pre-init `<script>`: `initAuth()` wiring and the Google OAuth redirect (`triggerGoogleSignIn`).
- **Lines ~54–1024** — `<style>`: all CSS, driven by CSS custom properties (`--bg-input`, `--text-muted`, `--radius-sm`, etc.) defined on `:root`.
- **Lines ~1026–3313** — `<body>`: every screen as a sibling element (`#loginScreen`, `#homeScreen`, `#estimatorScreen`, `#estimateEditorScreen`, `#estimatesScreen`, `#settingsScreen`, `#priceLookupScreen`, `#jobPlanScreen`, `#signsScreen`, etc.), plus modals.
- **Lines ~3314–18343** — the main `<script>`: all application logic.

### Navigation
There is no router. Screens are sibling DOM nodes; `hideAll()` (~line 4847) iterates the `allScreens` array and hides every screen (toggling `.active` for `*-section` elements, `style.display='none'` for others), then a `show*`/`render*` function reveals the target. When adding a screen, register its ID in the `allScreens` array or it won't hide correctly on navigation.

### Naming conventions
- `show*` functions reveal/populate a screen or modal (`showApp`, `showLogin`, `showSettingsTab`, `showPDFOptions`).
- `render*` functions rebuild the innerHTML of a list/section (`renderEstimatesList`, `renderJobPlan`, `renderCharges`, `renderSignsView`).
- `calc*`/`calculate*` are the pricing/volume/route math engines (`calculateEstimate`, `calcVolumePrice`, `calculateMattress`, `calcPallets`, `calculateDistances`).

## Backend (Supabase)

The app is fully client-side; all state lives in Supabase. Constants are defined near line 3607:
- `SUPABASE_URL = https://ozfkpxyachigfpcmvekz.supabase.co`
- `SUPABASE_ANON_KEY` — publishable anon key, hardcoded (this is expected for the anon flow).

**Data access goes through two helpers — use them, don't call `fetch` to Supabase directly:**
- `supabaseFetch(path, opts)` (~line 3666) — wraps PostgREST `/rest/v1/...` calls; injects `apikey` + auth headers and `Prefer: return=representation`; tolerates empty bodies (204/DELETE).
- `edgeFunctionCall(name, body)` (~line 3323) — invokes Edge Functions at `/functions/v1/...`.
- `supabaseClient` (the supabase-js UMD client) is used **only** for Storage signed URLs. Photos go to the `estimate-photos` bucket via `uploadPhotoToSupabase()`; display URLs come from `resolvePhotoUrl()`, which caches signed URLs for 12h and handles legacy Google Drive URLs.

### Tables (PostgREST)
`profiles`, `franchises`, `estimates`, `customer_price_lists`, `invites`, `crew_members`, `tools`, `job_plans`, `campaigns`, `feedback`, and the yard-signs set (`yard_signs`, `sign_credits`, `sign_status_events`, `sign_rewards`, `sign_sessions`).

Tenancy & Vonigo tables:
- `tenants` — parent of `franchises`; **`tenants.id` is the multi-tenant boundary.** Junkluggers tenant UUID: `946a4535-aa61-45b6-a6fb-9190ff546d41`.
- `vonigo_credentials` — links franchises to encrypted Vonigo credentials via Supabase Vault.
- `vonigo_credential_audit` — audit log for Vonigo credential access/changes.

### Edge Functions
Source lives in `supabase/functions/<name>/index.ts` (see "Supabase CLI" below). Deploy a single function with `supabase functions deploy <name>`.
- `crewlogic-ai` — AI estimate analysis (`action: 'analyzeEstimate'` with transcript/areas/photos); also handles estimate-submission AI actions.
- `crewlogic-settings` — franchise/cost/proposal settings reads & writes.
- `crewlogic-oauth-callback` — Google OAuth code exchange + profile provisioning; redirects back with `?session=...` or `?auth_error=...`.
- `crewlogic-job-plan` — job plan generation/persistence.
- `crewlogic-todays-workorders` — fetches today's work orders (Vonigo).
- `crewlogic-price-lookup` — pricing lookups.
- `crewlogic-estimate` — estimate save (`save` upserts to the `estimates` table) and `calcDistances` (Google Maps Distance Matrix lookup for cost-analysis routing). Replaces the n8n `save` + `calcDistances` webhook equivalents. Note: `delete` and `searchClients` actions still live in n8n (they require Vonigo OAuth).
- `crewlogic-pricing` — native price-book lookup for `crm_provider='none'` franchises (reads `price_lists` / `price_list_zips`). Returns the **same JSON shape** as `crewlogic-price-lookup` so the frontend estimating engine is unchanged — only the data source swaps. The client picks between them via `currentUser.pricingSource === 'native'` (~line 3615).
- `crewlogic-job-lookup` — looks up a single Vonigo job by `jobID` and returns the client/contact/location IDs + display info needed to hydrate an estimate. MD5 `/security/login/` auth (no Vonigo OAuth). Replaces the n8n `crewlogic-job-lookup` webhook.
- `crewlogic-trucks` — returns current truck GPS locations from Motive (gomotive.com); used by the Route Optimizer truck-distance display. Requires the `MOTIVE_API_KEY` secret. (The large route-optimization engine still lives in n8n.)
- `crewlogic-signup` — native self-provisioning: creates the tenant + franchise + profile for the native (non-Vonigo) signup flow. Junkluggers `@junkluggers.com` emails do **not** self-provision natively.
- `crewlogic-accept-invite` — provisions a profile from a pending invite token (service role); used by the invite-link flow (~line 3881).
- `crewlogic-photo-sweep` — **daily pg_cron job** (via pg_net). Permanently deletes soft-deleted estimate photos whose `deletedAt` is >30 days old, prunes the matching `estimates.payload.charges[*].deletedPhotos` JSONB entries (via SQL helpers `sweep_find_expired_photos()` / `sweep_prune_expired_photos()`), and removes the files from the `estimate-photos` Storage bucket. Idempotent; safe to call manually.
- `crewlogic-signs-lifecycle` — **daily pg_cron job** (via pg_net). Ages yard signs `active → gray` (after `graySignDays`, default 15) and `gray → hidden` (after `hiddenSignDays`, default 60) per-franchise via the SQL function `signs_daily_lifecycle()`; logs transitions to `sign_status_events` and posts a Slack summary if `SLACK_SIGNS_WEBHOOK` is set. Idempotent.

### Auth & multi-tenancy
Google OAuth uses `hd=junkluggers.com` for direct sign-ins. Today all owner accounts in production happen to have `@junkluggers.com` Google addresses. The invite-link flow exists and bypasses the `hd=` restriction (intended for inviting estimators with non-junkluggers email accounts), but currently no non-junkluggers.com accounts have actually used it. Adding email/password and magic-link auth for non-Google estimators is on the roadmap.

After callback, `currentUser` holds `role` (`'owner'` | `'crew'`), `franchiseID` (external), `franchiseInternalID`, `tenantID`, `franchiseName`. **Most queries are scoped by `currentUser.franchiseID` / tenant — preserve this scoping when writing new queries.** Access is gated in `showApp` by subscription `status` (`active`/`trialing`/`tester`/`pro`/`enterprise`); otherwise `#paywallScreen` shows.

### Legacy n8n
`N8N_BASE` (n8n.cloud webhook) and `apiFetch` still appear in some paths but are being migrated to Supabase Edge Functions. Prefer Edge Functions for new work.

### Supabase CLI
The repo is linked to the Supabase project `ozfkpxyachigfpcmvekz` via the Supabase CLI. The `supabase/` folder holds:
- `config.toml` — project config generated by `supabase init` (project_id `crewlogic`).
- `.gitignore` — excludes CLI-local state (`.temp/`, `.branches`, env files); these are **not** committed.
- `functions/<name>/index.ts` — one folder per Edge Function. Function source is being brought under management here (see "Edge Function source code" below).

Common commands (run from repo root):
- `supabase functions deploy <name>` — deploy one function to the linked project.
- `supabase functions deploy` — deploy all functions.
- `supabase functions serve <name>` — run a function locally.

## CDN dependencies (loaded in `<head>`)
`jspdf` (PDF generation), `pdf-lib` (PDF manipulation), `heic2any` (iPhone HEIC → JPEG), `piexifjs` (EXIF), `@supabase/supabase-js`. Plus Google Maps Street View (`STREET_VIEW_KEY`).

## Development workflow

- **Run locally:** open `index.html` directly in a browser, or serve the folder (`python3 -m http.server`). No build.
- **Versioning:** **single source of truth** — bump the `<meta name="crewlogic-version">` tag (line 5) on each release. Everything else derives from it at runtime: the console startup banner and `_FEEDBACK_APP_VERSION` both read the meta tag (`document.querySelector('meta[name="crewlogic-version"]').content`). Do **not** reintroduce hardcoded version strings elsewhere. Current: `5.9.81`. (Historical note: the console banner had silently drifted to 5.9.75 because it was a separate hardcoded string; the derive-from-meta refactor in 5.9.81 fixed that.)
- **Deploy:** Current workflow: `index.html` is downloaded from a Claude.ai chat session to `~/Downloads`, manually copied into `~/Documents/GitHub/crewlogic`, then committed to `main` via GitHub Desktop. Cloudflare Pages auto-deploys from `main` to `crewlogicai.com` (custom domain on the Cloudflare Pages project). The `crewlogic.pages.dev` URL still resolves as a transition fallback. Migrating this workflow to use Claude Code directly is in progress.

## Edge Function source code

Each Edge Function has a folder under `supabase/functions/<name>/` with its real `index.ts` committed to the repo (shared helpers live in `supabase/functions/_shared/`). As of 2026-06-02 all 14 deployed functions' source is under management here and verified byte-for-byte against prod, so they are editable directly via Claude Code.

Workflow: edit `supabase/functions/<name>/index.ts`, then deploy with `supabase functions deploy <name>` (prod deploys with the `ozfkpxyachigfpcmvekz` ref stay gated — see the approval discipline section). To re-verify a function against prod without deploying, download it read-only (`supabase functions download <name> --project-ref ozfkpxyachigfpcmvekz --workdir /tmp/fn-<name> --use-api`) and `diff` against the repo copy.

## Environments

Two Supabase projects: **prod** (`ozfkpxyachigfpcmvekz`) and **dev/`crewlogic-dev`** (`bagkimfwmpwjfhfhmsrb`). The dev project is used to build & verify features before promotion (see the dev tooling in the approval-discipline section: `dev-sql.sh`, `prod-readonly-sql.sh`). The frontend is still single-deploy (one `index.html` → Cloudflare Pages); dev/prod separation exists at the Supabase layer, with frontend/deploy separation still on the roadmap.

## SQL migrations

Migrations live in `supabase/migrations/` (sequential `NNNN_description.sql`; e.g. `0002_standalone_pricing_customers.sql`, `0004_tenant_provider_capabilities.sql`). Apply to dev first via the dev tooling, then promote to prod. Some older/ad-hoc SQL was historically run directly in the dashboard SQL Editor; new schema changes should be added as a numbered migration here.

## Branding

The rebrand from "CrewLogic" to "CrewLogicAI" happened recently. The brand name **CrewLogicAI** applies to: the app header, browser title, the login/invite/paywall screens, and the domain. Some user-facing strings still say "CrewLogic" **intentionally** — PDF filenames, invite copy, and the sign-out confirmation (per the rebrand decision noted in past chat sessions). Don't "fix" those to CrewLogicAI without checking.

## Editing notes

- Because everything is in one file, use line-anchored or uniquely-scoped edits; the same UI patterns (inline `onclick`, `style.display` toggles) repeat hundreds of times.
- UI is inline-style heavy and uses the CSS variables above — match existing variables rather than hardcoding colors.
- The app is mobile-first / PWA-style (`apple-mobile-web-app-capable`, fixed viewport, no user scaling).
