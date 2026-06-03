# CL-SPEC-004 — Phase 3: Row-Level Security / SEC-1

Status: **In progress — started 2026-06-03** (spec'd 2026-06-02). The security go-live gate. Follows
Phase 2 (Native Auth, CL-SPEC-003, shipped). Replaces the current wide-open RLS with tenant/franchise-
scoped policies enforced by a per-user Supabase JWT. Pre-auth flows audited 2026-06-02 (§4).
**Progress (2026-06-03):** scope helpers (migration 0006); client JWT in `supabaseFetch` (§6); dev
sign-in bypass upgraded to a **real Supabase session** (`signInWithPassword`; dev `auth.users` created +
linked — see `supabase/dev-setup/DEV_AUTH.md`); **`customers` RLS applied to dev** (migration 0007) and
verified — `dev-owner` (auth.uid → franchise `22222222`) sees its 81 customers, another franchise's rows
are invisible. First table live under scoped RLS in dev. **Then migration 0008** scoped the bulk franchise-data tables
(estimates, price_lists/blocks/items/zips, customer_price_lists, job_plans, crew_members, tools, campaigns,
yard_signs + sign_*) — 15 tables — applied to dev; dev-owner reads verified (incl. join-based
price_blocks/items; estimates filtered 13 of 15 total = scoping confirmed). Remaining: profiles, franchises,
tenants, invites/feedback carve-outs, vonigo_credentials/_audit.

## 1. Problem — current security posture (verified 2026-06-02)
- **Every RLS policy is `using (true)`** across all ~20 public tables (estimates, customers, profiles,
  franchises, tenants, price_lists/blocks/items/zips, customer_price_lists, job_plans, crew_members,
  tools, campaigns, invites, feedback, yard_signs + sign_credits/sessions/status_events/rewards). RLS is
  *enabled* but enforces nothing.
- **The client always authenticates as `anon`** — `supabaseFetch` (~index.html:4360) sends
  `SUPABASE_ANON_KEY` as both `apikey` and `Authorization`, never a per-user JWT.
- **Net effect:** no database-level isolation. Tenant/franchise separation is enforced **only** by
  client-side query filters (`franchise_id=eq.X`). The publishable anon key is in the page source, so
  anyone could read or write **any** franchise's/tenant's data with hand-crafted PostgREST calls. SEC-1
  closes this.

## 2. Goal
Enforce, at the database, that a request can only touch rows belonging to the requesting user's
franchise/tenant, scoped by role (owner vs crew/estimator) — via `auth.uid()`-based RLS policies and a
per-user JWT on every authenticated request. Edge functions (service-role) remain the trusted path for
provisioning and cross-cutting writes.

## 3. The gating dependency — universal `auth.uid()`
RLS keys off `auth.uid()`, which requires a Supabase Auth identity (`auth.users` row) for every user.
- **Native users:** ✅ have it (CL-SPEC-003; `profiles.auth_user_id` set by `crewlogic-signup` / `crewlogic-accept-invite`).
- **Google owners (current prod users):** ❌ custom JSON session, **no `auth.users`**. The
  `loginV2Google` Supabase-native Google OAuth path is the seed to build on.
- **Crew / estimators:** ❌ need identities (magic-link invite).

**SEC-1 cannot enforce until all users have `auth.uid()` and every `profiles` row has a populated
`auth_user_id`.** Sub-tasks: migrate Google sign-in onto Supabase Auth (or link `auth.users` to existing
Google profiles); backfill `auth_user_id` for all existing profiles; keep the custom-session shape
(`currentUser` / `cl_session_v2`) unchanged downstream (same approach as Phase 2).

## 4. Pre-auth carve-outs (audited 2026-06-02)
Accesses that happen before an authenticated session exists — these must stay reachable when policies
tighten, via a **narrow anon policy** or by **moving to a service-role edge function**:

| Flow | Table | Op | Where | Disposition |
|---|---|---|---|---|
| Invite screen / init | `invites` | SELECT by `token` | ~3749, ~5378 | **Narrow anon SELECT** scoped to `token=eq.` (no other columns leak); intentional pre-auth lookup |
| OAuth redirect handler | `profiles` | SELECT by `email` | ~3762 | Move to edge fn, OR narrow anon SELECT by email (privacy trade-off — prefer edge fn) |
| Cached-session refresh | `profiles` | SELECT by `email` | ~3794, ~3844 | Post-auth: **send user JWT** + `profiles` self/own-franchise policy |
| **Native session build** | `profiles` | SELECT by `email` | ~4150 (`buildSessionFromSupabaseAuth`) | **CRITICAL** — a Supabase JWT already exists here (`getSession()` at ~3896) but isn't sent. Fix: send the user JWT (see §6) |
| Feedback | `feedback` | INSERT | ~10148 | Keep **anon INSERT** (non-sensitive) or move to edge fn; no SELECT for anon |
| Native invite accept | (provisioning) | — | ~3903 | ✅ Already correct: sends user JWT to `crewlogic-accept-invite` (service-role) |

**Confirmed NOT pre-auth:** yard-signs / sign_* (all behind `currentUser.franchiseID`), paywall gating
(no DB read). Provisioning (`crewlogic-oauth-callback`, `crewlogic-signup`, `crewlogic-accept-invite`)
uses service-role and is RLS-exempt.

## 5. Scope-resolver helpers (SQL, `SECURITY DEFINER`) — ✅ built in dev (migration 0006, 2026-06-03)
Centralize scope resolution from `auth.uid()` (and avoid recursive RLS on `profiles`):
- `current_franchise_id()` → caller's `franchise_id`.
- `current_tenant_id()` → caller's tenant (via franchise→tenant).
- `current_user_role()` → `'owner'` | `'crew'`. *(Not `current_role()` — that's a reserved Postgres function.)*
All `STABLE SECURITY DEFINER` with a fixed `search_path`; execute granted to `authenticated`/`anon`
(they return NULL outside an authenticated context, which scoped policies treat as "matches nothing").

## 6. Client change — send the user JWT — ✅ built in dev (2026-06-03)
`supabaseFetch` now attaches the Supabase access token for logged-in users so PostgREST sees `auth.uid()`
(`_supabaseUserToken()` reads `getSession()`, refreshes a near-expiry token, falls back to the anon key).
Accepts an optional `opts.jwt` override for bootstrap reads. No-op while policies are open; verified the
app still works. Original requirement:
- Cache the access token (from `supabaseClient.auth.getSession()`) and send it as `Authorization: Bearer
  <jwt>` instead of the anon key when a session exists; keep `apikey: SUPABASE_ANON_KEY`.
- Accept an optional per-call JWT override for the bootstrap reads (e.g. `buildSessionFromSupabaseAuth`,
  which has the token before `currentUser` exists).
- Truly public/pre-auth calls (invite-by-token, feedback insert) keep using the anon key explicitly.
- **Dependency on §3:** Google owners only get a usable JWT once they're on Supabase Auth; until then
  their requests can't satisfy `auth.uid()` policies. This is why §3 gates the rollout.

## 7. Policy matrix (replace every `using(true)`)
Per table × command × role. Sketch (refine during build):
- **Franchise-scoped** (`franchise_id = current_franchise_id()`): estimates, customers,
  price_lists/blocks/items/zips, customer_price_lists, job_plans, crew_members, tools, campaigns,
  yard_signs, sign_credits, sign_sessions, sign_status_events, sign_rewards. Owners read/write own
  franchise; crew read + limited write (define per table).
- **Tenant-scoped**: `franchises` (rows in `current_tenant_id()`), `tenants` (read own only).
- **profiles**: read own; owners read same-franchise profiles; write own; provisioning stays edge-fn.
- **invites**: narrow anon SELECT by token (§4); owner INSERT/UPDATE scoped to own franchise.
- **feedback**: anon/authenticated INSERT; no broad SELECT.
- **vonigo_credentials / vonigo_credential_audit**: tightest — **owner-only**, franchise-scoped; never
  anon; ideally only touched via edge fn.

## 8. Storage RLS
The `estimate-photos` bucket holds franchise data (currently 12h signed URLs via `supabaseClient`).
Add bucket policies scoping object paths to the caller's franchise; confirm `uploadPhotoToSupabase` /
`resolvePhotoUrl` still work under them.

## 9. Build sequence (dev-first, table-by-table, gated)
1. **Universal auth (§3):** Google→Supabase Auth; backfill `profiles.auth_user_id`; verify every login
   path yields a JWT. *(Largest sub-project; can ship ahead of policy changes.)*
2. **Helpers (§5)** in dev.
3. **Client JWT (§6)** in dev — `supabaseFetch` sends the user token; verify all flows still work with
   policies still `true` (no behavior change yet).
4. **Tighten policies table-by-table** in dev, lowest-risk first; keep the §4 carve-outs. Verify the app
   per role + auth method after each table.
5. **Cross-tenant denial tests (§10).**
6. **Promote to prod** — gated, in lockstep (policies + client JWT must land together per table/cutover).

## 10. Testing strategy
**Dev-session blocker — RESOLVED 2026-06-03 (option a).** The dev sign-in bypass now mints a real
Supabase session (`devSignIn` → `signInWithPassword`); dev `auth.users` were created for
`dev-owner`/`dev-vonigo` and linked to their `profiles.auth_user_id` (setup + recreate steps in
`supabase/dev-setup/DEV_AUTH.md`). So scoped policies are now testable in-browser as those accounts, and
policy migrations can be applied to dev. (Original lopsided-data note: all 81 customers are on
`dev-owner`'s franchise `22222222`, which is now auth-linked — so `dev-owner` is the natural RLS test.)
Two proven test techniques:
- **SQL impersonation** (no browser): `begin; … set local role authenticated; select
  set_config('request.jwt.claims','{"sub":"<auth_user_id>"}',true); <queries>; rollback;` — used to prove
  the customers pattern 2026-06-03.
- For each table × role: with a scoped JWT, assert (a) own-franchise access works, (b) **cross-franchise
  and cross-tenant access is denied** (SELECT returns 0 rows; write 403). Script these (SQL or a small
  harness that mints two tenants' JWTs and probes each table).
- Regression: full app smoke per role (owner, crew) × auth method (Google, native) — estimate→PDF,
  pricing, signs, settings.
- Negative: a bare anon key can no longer read franchise data (only the §4 carve-outs).

## 11. Risks & rollout
- RLS bugs **leak data or lock everyone out** — both severe. Strictly dev-first; table-by-table; keep a
  fast rollback (revert policy = restore `using(true)` for that table).
- The §6 client JWT switch + §7 policies must be **coordinated** — tightening a table before the client
  sends JWTs locks it; sending JWTs before policies exist is harmless (still `true`). So: client JWT
  first (no-op), then policies.
- Google-auth migration (§3) must complete first or those users lose access the moment policies tighten.

## 12. Open decisions
- Scope unit: **franchise** vs **tenant** for owners who manage multiple franchises in one tenant.
- `profiles` visibility: own-only vs whole-franchise (owners need the team list → likely franchise-scoped for owners).
- Google migration: in-place link (`auth.users` ↔ existing profile by email) vs re-provision.
- Feedback + invites: anon policy vs edge-fn (lean anon for both; they're low-risk).
- **Dev test-session (§10):** upgrade `devSignIn` to mint a real Supabase session **(recommended)** vs.
  test RLS only via SQL impersonation + magic-link. Gates applying policy migrations to dev.

## 13. Checklist
- [ ] §3 Universal `auth.uid()`: Google→Supabase Auth; backfill `profiles.auth_user_id`; all logins yield a JWT.
- [x] §5 Scope-resolver SQL helpers (dev) — migration 0006, applied & verified 2026-06-03.
- [x] §6 `supabaseFetch` sends user JWT (dev), 2026-06-03; no-op while policies open.
- [x] **§10 dev test-session** — RESOLVED 2026-06-03: dev bypass mints a real session (`DEV_AUTH.md`).
- [ ] §4 Pre-auth carve-outs implemented (invites by-token; profiles bootstrap via JWT/edge fn; feedback insert).
- [~] §7 Per-table scoped policies replacing `using(true)`, table-by-table (dev). **Done in dev: customers (0007) + 15 franchise-data tables (0008), reads verified 2026-06-03.** Remaining: profiles, franchises, tenants, invites/feedback (carve-outs), vonigo_credentials/_audit.
- [ ] §8 `estimate-photos` storage policies.
- [ ] §10 Cross-tenant denial tests + per-role regression.
- [ ] §9.6 Gated prod promotion (policies + client JWT in lockstep).
