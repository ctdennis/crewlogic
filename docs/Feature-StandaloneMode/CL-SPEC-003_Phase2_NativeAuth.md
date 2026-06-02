# CL-SPEC-003 — Phase 2: Native Auth Front Gate (Supabase Auth, invite-first)

Status: **Built & shipped** (login V2 shipped v5.18.0; verified complete 2026-06-02; spec'd 2026-05-29).
Follows Phase 1 (provider hydration, shipped v5.11.4). All deliverables live: Supabase Auth magic-link
(`signInWithOtp`) on the V2 login + invite screens, client session builder `buildSessionFromSupabaseAuth()`,
and native provisioning via `_shared/provisionNative.ts` (shared by `crewlogic-signup`, `-accept-invite`,
`-oauth-callback`). Google flow untouched; `@junkluggers.com` gated to Google. Magic-link only (no
password auth) by design. Next: Phase 3 (RLS/SEC-1).
Decisions (owner, 2026-05-29): **(1) foundation = Supabase Auth** for native owners (email/password +
magic-link); **(2) provisioning = invite-first** (extend the existing invite flow; public self-serve
signup is a later step toward the end state). End state = self-provisioning + subscription + trial.

## 1. Why Supabase Auth (vs the current custom session)
Today auth is fully custom: Google OAuth → `crewlogic-oauth-callback` builds a JSON session → client
stores it in `localStorage` (`cl_session_v2`) → `currentUser = session`. There are **no `auth.users`**.
Supabase Auth gives real `auth.users`/`auth.uid()` — required for **Phase 3 RLS**, and provides
email/password, magic-link, password reset, and email verification out of the box (the self-serve
plumbing). The existing Google flow stays custom for now; the two coexist (see §3).

## 2. The key reconciliation — one session shape, two front doors
Downstream code depends on `currentUser` (the JSON session). Phase 2 keeps that uniform:
- **Google (unchanged):** edge callback builds the session (now with capability hydration, Phase 1).
- **Native (new):** after a Supabase Auth sign-in, the **client** builds the *same* session shape by
  fetching `profiles?select=...franchises(...tenants(id,subscription_status,pricing_source,customer_source,submission_target))`
  (identical select to the callback) keyed by the authed email, then stores it in `cl_session_v2`.
  → `currentUser` is byte-compatible regardless of auth method; the whole app is unaffected.

## 3. Coexistence
- Google sign-in button + flow: untouched (custom session).
- Native email/magic-link: Supabase Auth (`supabaseClient.auth.*`). The Supabase session is used ONLY
  to (a) authenticate and (b) build the custom `currentUser` session; the app otherwise still reads
  `currentUser`. (Phase 3 may later use the Supabase JWT directly for RLS.)

## 4. Provisioning (invite-first)
Extend the existing invite flow (invites table; `checkInviteToken` ~4798; provisioning in the callback
~§87). For a **native franchisee invite**:
1. Owner opens invite link → invite screen shows **"Continue with email"** (alongside Google).
2. Email path → Supabase Auth: first accept sets a password (or magic-link), creating `auth.users`.
3. Provision (edge function, service role): create **tenant (native defaults: pricing/customer=native,
   submission=none, subscription_status=trialing)** + **franchise** + **owner profile** linked to the
   auth user's email. (Mirrors the "external franchisee tester" path, but native + no Vonigo.)
4. Build `currentUser` session (§2) → `showApp()`.
Returning native owners: login screen email/magic-link → Supabase Auth → build session → app.

## 5. Build sequence (dev first, then promote — same flow as Phase 1)
1. **Enable Supabase Auth email** (email/password + magic-link) in the **dev** project (config + redirect
   URLs); confirm `supabaseClient.auth` works against dev. (Dashboard/config; non-destructive.)
2. **Login + invite UI:** add an email/magic-link option (native) to the login screen and the invite
   screen, beside Google.
3. **Client auth + session builder:** `supabaseClient.auth.signUp/signInWithPassword/signInWithOtp`;
   on success, fetch profile→franchise→tenant and build `currentUser` (reuse Phase 1 hydration shape).
4. **Native invite provisioning** edge function: invite → create tenant(native)+franchise+profile.
5. **Test in dev:** issue a native invite, accept via email, verify native UI + session + a full native
   estimate→PDF; confirm Google flow still works.
6. **Promote:** enable email auth on the **prod** project, deploy fns, `index.html`→main; smoke test.

## 6. Open sub-decisions (resolve during build)
- First-accept: **password vs magic-link** (or offer both). Lean: magic-link for accept (no password to
  set), password optional later. Confirm with owner at step 2.
- Provisioning lives in an **edge function** (service role) — not client — so RLS/least-privilege holds.
- Email deliverability: Supabase's built-in SMTP for dev; prod may need a custom SMTP (deliverability).
- Ties into **Phase 3 (RLS/SEC-1)**: native `auth.users` is the subject; plan RLS policies against
  `auth.uid()` ↔ profile ↔ tenant. (Separate spec.)

## 7. Guardrails
- Do NOT change the working Google flow. Native paths are additive and gated to native tenants.
- Build/verify entirely in dev first; the prod Junkluggers app must be unaffected at every step.
