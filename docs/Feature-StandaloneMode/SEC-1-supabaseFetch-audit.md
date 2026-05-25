# SEC-1 — `supabaseFetch` audit (browser → PostgREST exposure)

| | |
|---|---|
| **For** | CL-BRD-002 §14.4 (S-C.0 / SEC-1 hard gate) |
| **Date** | 2026-05-25 |
| **Scope** | Read-only. Inventory every direct browser→PostgREST call, its method, and its scoping; assess what RLS tightening requires given current auth. |
| **Input** | `index.html` (~18k lines), helper `supabaseFetch` at line 3666. |

---

## 1. Headline

The app makes **80 direct browser→PostgREST calls** across **15 tables** (14 of them written to
directly from the browser). **All run as the Supabase `anon` role** — `supabaseFetch` sends only the
anon key for both `apikey` and `Authorization` (line 3670-3671); there is **no per-user Supabase
JWT**. `currentUser.token` exists but is used only for n8n calls (`apiFetch`, line 3382), never for
PostgREST. **Therefore `auth.uid()` is null on every data request.**

Combined with the D0 finding that all RLS policies are permissive (`USING (true)`, role `public`),
**tenant isolation today is enforced entirely in application code**, not by the database.

## 2. The SEC-1 blocker (auth architecture)

The originally-sketched SEC-1 fix — *scope rows via `profiles WHERE auth_user_id = auth.uid()`* —
**cannot work as-is**: with no user JWT, `auth.uid()` is null, so such a policy would match zero
rows and break all 80 calls. SEC-1 must therefore begin with an **auth-architecture decision**:

| Option | Mechanism | RLS basis | Effort | Notes |
|---|---|---|---|---|
| **A. Adopt Supabase Auth** | OAuth callback mints a real gotrue session; `supabaseFetch` sends the user's JWT as bearer | `auth.uid()` / `profiles` join | Medium–large | Architecturally correct; reuses Supabase's session/refresh; smallest per-query change (just the header) |
| **B. Edge-function gateway** | Route all 80 calls through service-role edge functions enforcing franchise scoping in code; revoke anon table grants | n/a (service role bypasses RLS; code enforces) | Large | Biggest refactor (80 call sites → endpoints); strongest control; also removes the anon-key exposure entirely |
| **C. Custom signed JWT** | Mint a tenant-claim JWT signed with the Supabase JWT secret; send as bearer | `auth.jwt()` claims (e.g. franchise_id) | Medium | No gotrue dependency; must manage signing/rotation/expiry ourselves |

**Recommendation:** Option **A** unless there's a reason to avoid Supabase Auth — it makes
`auth.uid()`-based RLS work, is the smallest change per call site (header only, since the
response shapes don't change), and is the assumption baked into the rest of the standalone plan.
Decide before writing any policies.

## 3. Exposure classes (what tightening must address)

1. **`row-id` "scoping" is not security.** Writes like `PATCH estimates?id=eq.<X>` /
   `DELETE tools?id=eq.<X>` target one row, but under permissive RLS the anon key can target ANY
   id. Affected write tables: `estimates`, `tools`, `customer_price_lists`, `yard_signs`,
   `crew_members`, `sign_credits`, `sign_sessions`, `sign_rewards`, `sign_status_events`, `invites`,
   `job_plans`, `campaigns`, `profiles`. Real RLS must verify the row belongs to the caller's
   franchise/tenant, not just that an id was supplied.

2. **Outright UNSCOPED calls (no tenant/owner filter at all):**
   - `customer_price_lists` POST — line 4254
   - `invites` POST (owner invite, franchise_id null) — line 4418
   - `feedback` POST — line 8697
   - `yard_signs` GET — line 15944
   - `sign_status_events` POST ×4 — lines 16216, 16241, 16267, 16736
   - `sign_credits` POST — line 16752
   - `tools` POST — line 17617

3. **`email`-scoped reads** (`profiles`, `estimates`) rely on the client passing the right email;
   secure only once RLS ties rows to the authenticated identity.

## 4. Full inventory (by table)

Method: GET = read; POST/PATCH/DELETE = write. Scoping: `franchise` / `tenant` / `email` /
`row-id` / `UNSCOPED` (see §3 for why `row-id`/`email` aren't sufficient under real multi-tenancy).

**campaigns** — 15853 GET franchise · 17398 POST franchise
**crew_members** — 15846 GET franchise · 17225 POST franchise · 17323 PATCH row-id · 17335 PATCH(delete) row-id · 17738 GET row-id(in)
**customer_price_lists** — 3720 GET franchise · 3941 GET franchise · 4249 PATCH row-id · **4254 POST UNSCOPED** · 4273 GET row-id · 4316 DELETE row-id · 7108 GET franchise
**estimates** — 6775 GET email · 6951 GET row-id · 7347 DELETE row-id · 7394 DELETE row-id · 10845 GET email · 10996 GET row-id · 11155 PATCH row-id · 11198 PATCH row-id
**feedback** — **8697 POST UNSCOPED**
**franchises** — 3749 GET tenant · 4334 GET tenant · 4468 GET tenant
**invites** — 3449 GET row-id(token) · 4349 POST franchise · **4418 POST UNSCOPED** · 4603 GET row-id(token) · 4680 PATCH row-id
**job_plans** — 5266 GET franchise · 5333 POST franchise · 5430 PATCH franchise
**profiles** — 3462 GET email · 3494 GET email · 3529 GET email · 4345 GET email · 4408 GET email · 4474 GET franchise · 4509 DELETE email · 4667 POST franchise · 4995 GET email · 5236 GET email · 11676 GET email
**sign_credits** — 16097 GET franchise · 16427 DELETE row-id · **16752 POST UNSCOPED** · 16831 DELETE row-id · 17046 GET row-id · 17073 PATCH row-id · 17873 GET row-id
**sign_rewards** — 17057 POST franchise · 17727 GET franchise · 17782 PATCH row-id · 17835 GET franchise
**sign_sessions** — 16354 POST franchise · 16399 PATCH row-id · 16437 PATCH row-id
**sign_status_events** — **16216 POST UNSCOPED** · **16241 POST UNSCOPED** · **16267 POST UNSCOPED** · **16736 POST UNSCOPED**
**tools** — 17435 GET franchise · 17608 PATCH row-id · **17617 POST UNSCOPED** · 17651 DELETE row-id
**yard_signs** — **15944 GET UNSCOPED** · 16212 PATCH row-id · 16237 PATCH row-id · 16263 PATCH row-id · 16429 DELETE row-id · 16500 GET franchise · 16508 PATCH row-id · 16707 POST franchise · 16781 PATCH row-id · 16835 DELETE row-id

Totals: **GET 44 · POST 20 · PATCH 13 · DELETE 3 = 80.**

## 5. Updated SEC-1 gate (supersedes the §14.4 S-C.0 sketch)

1. **Decide the auth approach (A/B/C above).** Default to A.
2. If A or C: change `supabaseFetch` to send the per-user token as `Authorization` (response shapes
   unchanged). If B: build the edge-function gateway and migrate the 80 calls.
3. Write franchise/tenant-scoped RLS for all existing tables AND the new standalone tables; verify
   `row-id` writes are rejected when the row is outside the caller's franchise.
4. Fix the 10 UNSCOPED calls (§3.2) to carry/enforce franchise scope.
5. Regression pass on all 80 call sites (ideally in a dev environment); `security-review` skill.
6. **Hard gate:** no second (non-Junkluggers) tenant may exist until 1–5 are live and verified.

---

## 6. DECISION (2026-05-25): adopt Option A — Supabase Auth

Chosen: **Option A.** No strong reason for B or C — gotrue is already in use, so A is both the
correct fit and the lowest-lift. B (edge-function gateway) would be a needless 80-call refactor;
C (custom JWT) would reinvent what gotrue already provides.

### Why A is largely pre-built (verified 2026-05-25)
- `crewlogic-oauth-callback` already signs into Supabase Auth via the id_token grant
  (`/auth/v1/token?grant_type=id_token`, line 152) → `auth.users` exists per user.
- It already mints a Supabase JWT and ships it to the frontend as `session.supabaseToken`
  (line 313).
- `profiles.auth_user_id` already links profiles → `auth.users` — exactly what `auth.uid()` RLS needs.
- Confirmed gaps: `supabaseToken` is **never referenced in `index.html`** (delivered but unused —
  `supabaseFetch` uses the anon key); and the callback captures **no refresh_token / expiry**
  (the Supabase access token would expire ~1h with no renewal path).

### Option A work breakdown (refines §5 steps 1–2)
1. **Harden the Supabase sign-in.** Today `signIntoSupabase` is non-fatal (line 167) — on failure
   the user has no JWT. Once RLS is scoped, a null JWT = locked out. Make the token reliably present
   (fail the login, or a defined fallback) before tightening RLS.
2. **Capture refresh_token + expiry** in the callback session (gotrue returns them; currently
   dropped — only `access_token` is plumbed).
3. **Frontend session management:** store `supabaseToken` + refresh_token; refresh before expiry
   (manual refresh call, or via the supabase-js client's `setSession`); persist across reloads
   (the app already restores its session object from storage).
4. **`supabaseFetch`:** send `Authorization: Bearer <supabaseToken>` (keep `apikey` = anon).
   One-function change; response shapes unchanged, so no consumer code changes.
5. Then proceed to scoped RLS (§5 step 3), the 10 unscoped fixes (§5 step 4), and the regression
   pass (§5 step 5).

### Related cleanup to fold in
- The D0 `subscriptionStatus` vs `subscriptionTier` mismatch: the callback DOES set
  `subscriptionStatus` on the session (line 309), but the in-app profile-reload paths set
  `subscriptionTier`. Align these while touching session handling here.

### Sequencing
Do this in a **dev environment**, not production — it changes the live auth/session path and
requires a regression pass over all 80 data calls.
