# CL-PLAN-001 — Dev/Prod Split: kickoff plan

| | |
|---|---|
| **Status** | Queued — start 2026-05-26 |
| **Why now** | n8n is down to one workflow and everything else runs on Supabase, so the surfaces to replicate for a dev environment are far fewer. Dev/prod is the prerequisite for SEC-1 (auth + RLS) and any risky shared-surface work (see `CL-BRD-002`). |
| **Goal** | A separate **dev** Supabase project + **dev** frontend deploy, so changes (esp. auth/RLS) can be built and regression-tested off production. |

## Guiding principle
Additive-first / parallel build (same axis as CL-BRD-002 §14): create **new, separate** dev resources; never mutate prod to create dev. Reading prod (schema dump) is fine; writing/pointing prod is not.

## The shared surfaces (and how to keep prod safe)
| Surface | Risk to prod | Mitigation |
|---|---|---|
| **Frontend config hardcoded to prod** (`SUPABASE_URL` :~3607, `N8N_BASE` :3317, OAuth `redirect`/`APP_URL`) | Editing on `main` → Cloudflare redeploys prod pointing at dev | **Hostname-based switch**: detect dev hostname → use dev constants. This is a small *additive* change safe to ship on `main` (prod behavior identical). It becomes the seam dev hangs off. |
| **Supabase CLI linked to prod** | `functions deploy` / `db` hit prod by default | Use `--project-ref <dev>` (or switch link) for dev; the prod gates stay on. |
| **Shared third-party systems** (Vonigo, Motive, the one remaining n8n route workflow) | Dev writing into **prod** Vonigo / Motive / n8n | **Biggest risk.** Dev must NOT write to prod Vonigo (submit/delete). Point dev at sandbox creds or fence these off. For testing, prefer read paths + throwaway records. |
| **Shared API keys** (Anthropic, Google Maps/Geocoding, Motive) | Dev usage consumes prod quota; referrer-restricted Maps keys may not work on dev domain | Separate dev keys, or accept shared quota knowingly. |
| **Copying prod data into dev** | Duplicates customer PII into a second system (worse given permissive RLS — see SEC-1) | Seed dev with **synthetic** data; copy prod only if necessary, treat as sensitive. |

## Standup sequence (Stage 0 of the dev environment)
1. **New dev Supabase project** (separate URL/keys/DB/storage). Net-new; zero prod impact.
2. **Replicate schema** into dev (pg_dump from prod is read-only on prod → apply to dev). Include the new standalone tables when we get there.
3. **Dev frontend**: either a Cloudflare Pages **preview branch** (dev branch → preview URL) or the **hostname switch** above. Dev branch pushes are now gate-free.
4. **Dev OAuth client** (separate Google client + dev redirect URI) so prod login is untouched.
5. **Point dev config** at the dev project (via the hostname switch / dev branch only — never on `main`).
6. **Seed synthetic data** in dev (incl. a test tenant/franchise, per CL-BRD-002 S-A.4).

## Permission model for dev work (already partly set)
- ✅ Done: `git push origin main` is the only gated push (prod publish). Feature/dev-branch pushes run free.
- Tomorrow: once the dev project ref is known, scope the `supabase functions deploy` / `db` gates so **dev-project** operations run free and only **prod-project** ones prompt.
- Net: free in dev, gated in prod.

## First Claude Code prompt (paste tomorrow)
```
Start the dev/prod split per docs/DevProdSplit/CL-PLAN-001. Begin read-only/plan:
1) Confirm the current prod schema we'd replicate (tables, RLS, functions, extensions,
   storage buckets) and produce a dump/migration we can apply to a fresh dev project.
2) Propose the dev frontend approach: hostname-based config switch in index.html
   (additive, prod-identical) vs. Cloudflare preview branch — recommend one.
3) List exactly which third-party integrations (Vonigo, Motive, the n8n route workflow,
   API keys) must be fenced/sandboxed so dev can never write to prod systems.
Output a step-by-step standup checklist; don't create the dev project until I confirm.
```

## Open decisions for tomorrow
1. Dev frontend: hostname-switch vs Cloudflare preview branch.
2. Third-party isolation strategy (the Vonigo/Motive write-safety question).
3. Synthetic seed vs. (carefully) copied prod data for dev.
