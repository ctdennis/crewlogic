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

## Workflows flagged NOT called by the app — DISABLED 2026-05-25 ✅
All four confirmed not called by the app, **disabled in n8n**, and local copies removed from the repo folder:
- **CrewLogic Auth** (`crewlogic-auth`) — superseded by the Supabase oauth-callback edge function. Disabled + removed.
- **WebLogic oAuth** (`crewlogic-oauth-callback`) — app's Google redirect points at the Supabase function, not this n8n webhook. Disabled + removed.
- **Create Image & Video Via Slack Prompt** (`slack-video-request`) — not CrewLogic; **kept ACTIVE in n8n for a different project**, removed from this repo folder only.
- **Estimates** (Slack-triggered) — not called by the app. Disabled + removed.

## Migration status (live)
- [x] `crewlogic-job-lookup` → edge function ✅ **DONE 2026-05-25** — deployed, parity-validated vs live n8n (real job 842018), frontend repointed (v5.9.78). The n8n `crewlogic-job-lookup` workflow can now be disabled.
- [x] `crewlogic-jobs` → **ELIMINATED 2026-05-25** — was a #90-only Route Optimizer prototype reading a manual Google Sheet. Repointed `loadUpcomingJobs()` to the existing `crewlogic-todays-workorders` (Vonigo direct, dayOffset 0; v5.9.79). No new function. The n8n `crewlogic-jobs` workflow + its Google Sheet can be retired.
- [x] `crewlogic-estimate` searchClients + delete → **DONE 2026-05-25** (crewlogic-estimate now FULLY off n8n)
  - [x] **searchClients** — crewlogic-estimate v1.3, MD5 Vonigo auth (no OAuth). Parity vs n8n (searchPar=Diaz: identical 11 clients). Frontend repointed (v5.9.84). UI-tested ✓.
  - [x] **delete** — crewlogic-estimate v1.4, `POST /data/Quotes/ {method:4, objectID}`. Bogus-ID tests safely rejected (no real deletion). NOTE: n8n masked all delete results as success:true; the edge fn returns the real Vonigo result (frontend ignores it — best-effort — so no functional change). Frontend repointed (v5.9.85). **Real-quote delete still to be confirmed by deleting a throwaway submitted estimate.**
  - ✅ The n8n `CrewLogic Estimates` workflow is now fully unused (save/searchClients/delete all migrated) → can be DISABLED.
- [ ] `crewlogic-submit-quote` → edge function *(multi-step + Vonigo document upload)*
- [ ] `crewlogic-route` / `crewlogic-trucks` → migrate (carry Motive key) or retire (#90-only)
- Cron automations (`Signs - Daily Lifecycle`, `Soft-Delete Photo Sweep`) → later (pg_cron / scheduled fn)
