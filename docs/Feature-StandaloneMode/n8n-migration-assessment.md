# n8n → Edge Function migration assessment

| | |
|---|---|
| **For** | CL-BRD-002 (tech-debt reduction before prod migration) |
| **Date** | 2026-05-25 |
| **Source** | n8n workflow exports analyzed locally in `n8n-workflows/` (gitignored) |
| **Headline** | **No Vonigo OAuth exists. All 6 frontend n8n endpoints are migratable to edge functions; n8n can be fully eliminated as a frontend dependency.** |

## Key finding: the "Vonigo OAuth" blocker is a myth

Every Vonigo call in every workflow authenticates via `GET …/api/v1/security/login/` → `securityToken`
(MD5 login), with HTTP nodes set to `auth: none` and **no OAuth credential anywhere**. This is the
**same flow the edge functions already use** (`crewlogic-todays-workorders`, `crewlogic-price-lookup`).
CLAUDE.md's claim that `searchClients`/`delete` "require Vonigo OAuth" is **outdated/incorrect** and
should be corrected.

## Per-endpoint verdict

| App n8n path | Workflow | Auth | External deps | Complexity | Verdict |
|---|---|---|---|---|---|
| `crewlogic-estimate` (searchClients, delete) | CrewLogic Estimates | Vonigo MD5 | `/data/Clients/`, `/data/Quotes/` | Low | **Migrate** — add 2 actions to existing `crewlogic-estimate` edge fn (already does save + calcDistances) |
| `crewlogic-job-lookup` | CrewLogic Job Lookup | Vonigo MD5 | `/data/WorkOrders/`, `/data/Contacts/` | Low | **Migrate** — mirrors `crewlogic-todays-workorders` |
| `crewlogic-jobs` | CrewLogic Jobs | — | **Google Sheets** | Low–Med | **Migrate** — data source is a Google Sheet (not Vonigo); good chance to move it into Supabase |
| `crewlogic-submit-quote` | CrewLogic Submit Quote v9 | Vonigo MD5 | Quotes + `/data/documents/` (base64 photo upload), Maps | Med–High | **Migrate** — heaviest (multi-step: auth → create quote → upload photos → edit fields); no blocker. `crewlogic-ai` already proves server-side base64 handling. |
| `crewlogic-route` + `crewlogic-trucks` | Route Optimization | Vonigo MD5 | Vonigo, Google Maps, Anthropic, **Motive (`api.gomotive.com`)** | Med | **Migrate or retire** — needs the Motive telematics API key in edge secrets. It's the franchise-#90-only tester feature, so retiring/deferring is a legitimate option. |

## Notable dependencies surfaced
- **`crewlogic-jobs` → Google Sheets** (n8n `googleSheets` node). A legacy data source hiding behind the webhook.
- **Route optimizer → Motive** (`api.gomotive.com/v1|v3/vehicle_locations`) for truck GPS — a real external telematics integration; key must move to edge secrets if migrated.
- Distances/geocoding (Google Maps) and Anthropic are already available to edge functions.

## 🔒 Security note
HTTP nodes use `auth: none` with **inline credentials** (no n8n credential store), so these JSON
exports almost certainly contain hardcoded secrets: Vonigo username + MD5 hash, Motive API key,
Anthropic key, Google Maps key, Google Sheets creds.
- Keep the exports **gitignored** (they are).
- Migration **improves** posture: edge functions pull from Supabase Vault / edge secrets instead of inline.
- Treat the migration as a **credential-rotation** opportunity.

## Recommended sequence (lowest-risk first)
1. **Gate all n8n calls behind `crmProvider === 'vonigo'`** (cheap) so standalone tenants are n8n-free and n8n leaves the dev/prod shared surface for everything but legacy Junkluggers.
2. **Migrate the low-complexity reads:** `crewlogic-job-lookup`, then `crewlogic-jobs` (decide Sheets→Supabase).
3. **Migrate `crewlogic-estimate` actions** (searchClients, delete) into the existing edge function.
4. **Migrate `crewlogic-submit-quote`** (the big one; includes Vonigo document upload).
5. **Decide `crewlogic-route`/`crewlogic-trucks`:** migrate (carry Motive key) or retire (#90-only).
6. Once all six are migrated, **delete n8n** (frontend). Separately, the cron automations
   (`CrewLogic Signs - Daily Lifecycle`, `CrewLogic Soft-Delete Photo Sweep`) can later move to
   Supabase scheduled functions / pg_cron.

## Workflows flagged NOT called by the app (turn off in n8n, then delete local copies)
- **CrewLogic Auth** (`crewlogic-auth`) — superseded by the Supabase oauth-callback edge function.
- **WebLogic oAuth** (`crewlogic-oauth-callback`) — the app's Google redirect points at the Supabase
  function, not this n8n webhook. Dead.
- **Create Image & Video Via Slack Prompt** (`slack-video-request`) — not CrewLogic (different project).
- **Estimates** (Slack-triggered) — not called by the app; confirm it isn't a Slack automation in use.
