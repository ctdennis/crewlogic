# Provisioning & Access Matrix — Canonical Spec

_Created 2026-06-10. **This is the source of truth for who gets Vonigo vs. native, and trial vs. non-expiring, based on how they enter and their email domain.** Confirmed with owner 2026-06-10._

## The model — two independent switches

Everything is determined by two orthogonal switches:

1. **Entry point → the clock.**
   - **Guest-invite link** (owner generates in Settings → Guest Tester) → **never expires** (`tester`).
   - **Marketing site** (crewlogicai.com signup) → **14-day trial** (`trialing`, `trial_ends_at = now + 14d`).
2. **Email domain → Vonigo vs native.**
   - **`@junkluggers.com`** → **Vonigo track** (Junkluggers tenant, `crm_type='vonigo'`).
   - **any other domain** → **native** (own tenant, `crm_type='none'`, no Vonigo).

## The matrix

| Entry point | Identity | Vonigo? | Expiration |
|---|---|---|---|
| Guest invite | `@junkluggers.com` (Google) | ✅ Vonigo | ♾️ never (`tester`) |
| Guest invite | other Google account | ❌ native | ♾️ never (`tester`) |
| Guest invite | non-Google email/password | ❌ native | ♾️ never (`tester`) |
| Marketing | `@junkluggers.com` (Google) | ✅ Vonigo | ⏳ 14-day trial |
| Marketing | other Google account | ❌ native | ⏳ 14-day trial |
| Marketing | non-Google email/password | ❌ native | ⏳ 14-day trial |

## Confirmed rules (owner, 2026-06-10)

- **Trigger is the email *domain*** (`@junkluggers.com`), not the auth method. In practice the login picker already routes any `@junkluggers.com` login to Google, so email/password users are always non-junkluggers → native. Domain and "Google path" converge; treat the rule as **domain-based**.
- **"Vonigo access" = on the Vonigo track + a one-time credentials step.** The system cannot know *which* Junkluggers franchise a person is from their email alone. A `@junkluggers.com` user lands in the Junkluggers/Vonigo path and must **enter their Vonigo UID + password once in Settings → Vonigo Integration**, which auto-discovers and connects their specific franchise (`saveVonigoCredentials` → `crewlogic-settings`, attaches a franchise under the shared Junkluggers tenant, stores creds in Vault, sets `vonigo_configured=true`, seeds tools from #90). Not magically pre-connected.

## Current behavior vs. desired (the gap)

**Today the system does NOT branch on `@junkluggers.com` at provisioning, and does not let Junkluggers users self-onboard.** Specifics:

- **Clock (entry point):** ✅ mostly correct.
  - Guest invite → `tester` / no clock (fixed 2026-06-10 in `crewlogic-accept-invite` + `crewlogic-oauth-callback` provisionFromInvite via `createNativeTenantAndFranchise(..., {subscriptionStatus:'tester', setTrialClock:false})`).
  - Marketing → `trialing` + 14-day clock (`crewlogic-signup` → `createNativeTenantAndFranchise` default).
- **Vonigo branch (domain):** ❌ NOT implemented. Both entry points provision **native** regardless of domain. A `@junkluggers.com` user does not get auto-routed to the Vonigo track; they'd land native and would have to connect Vonigo manually (which moves them to the Junkluggers tenant).
- **Junkluggers can't self-onboard today:**
  - Frontend routes any `@junkluggers.com` email to Google (`_isJunkluggersEmail` → `loginV2Choose('google')`, index.html ~4109/4131/4144) and blocks them from email/password signup (~4213/4229/5545: "Junkluggers accounts sign in with Google").
  - A brand-new `@junkluggers.com` Google sign-in with **no profile** hits the **`no_account`** screen (`resumeNativeSession` guard) — it does **not** self-provision. So new Junkluggers owners can only get in via an **invite** (or manual provisioning). `crewlogic-signup` itself has no junkluggers handling.

## Implementation surface (where the branching must go)

- **Guest invite accept:** `crewlogic-accept-invite` (magic-link) + `crewlogic-oauth-callback` `provisionFromInvite` (Google) — add: if accepter email is `@junkluggers.com`, provision onto the **Vonigo track** (Junkluggers tenant, pending franchise to be finalized by the creds step) instead of a native tenant; keep `tester`.
- **Marketing signup:** `crewlogic-signup` (+ the app `showSignupScreen` / login routing that currently *blocks* junkluggers) — add: allow `@junkluggers.com` through, provision onto the Vonigo track, keep `trialing`.
- **Vonigo connect (already built):** `crewlogic-settings` `saveVonigoCredentials` — auto-discovers franchise, attaches under Junkluggers tenant, stores creds. Reuse as the one-time creds step.
- **Domain helper:** `_isJunkluggersEmail` (index.html ~4167) client-side; needs a server-side equivalent in the provisioning functions.

## Open design decisions / risks to resolve during build

1. **★ The marketing + `@junkluggers.com` cell (Vonigo + 14-day trial) conflicts with the shared-tenant model.** Trial state (`subscription_status`, `trial_ends_at`) lives on the **tenant**, but all Junkluggers franchises share ONE tenant which is `tester` (never expires). You cannot give one Junkluggers franchise a 14-day clock while others are `tester` if the clock is tenant-level. **Needs a decision:** move trial tracking to **per-franchise** (add `subscription_status`/`trial_ends_at` to `franchises`, gate reads franchise-first), or accept that marketing+junkluggers can't truly be time-limited inside the shared tenant. (This is the least-urgent cell — see sequencing.)
2. **Orphaned native tenant:** if a junkluggers user is provisioned native first and then connects Vonigo, their original native tenant is left behind. The fix in #1 (route junkluggers straight to the Vonigo track, never create the native tenant) also removes this.
3. **Access gate on the new Junkluggers franchise:** `saveVonigoCredentials` creates the franchise without `subscription_tier` (defaults toward `free`). Post-v5.27.2 the gate grants access when *either* franchise tier OR tenant status is an access value, so the shared `tester` tenant covers it — but verify the first real connect does **not** paywall (this trap hit testers #54/#31 before).
4. **Dev testing nuance:** `crewlogic-settings` hardcodes the **prod** Junkluggers tenant UUID (`946a4535…`), so the Vonigo-connect path can't be exercised identically on dev without accommodation.

## Proposed build sequence (most-urgent first)

1. **Guest invite + `@junkluggers.com` → Vonigo track, `tester`** — this is the immediate need (onboarding real Junkluggers franchisees like Ben Spilger). No clock conflict (tester = shared-tenant default).
2. **Guest invite + other domain → native, `tester`** — already correct; just confirm.
3. **Marketing + non-junkluggers → native, `trialing`** — already correct; just confirm.
4. **Marketing + `@junkluggers.com` → Vonigo + 14-day** — LAST; blocked on decision #1 (per-franchise trial clock).

## Onboarding playbook
_To be written once the build matches this matrix._ Will cover: owner generates the right invite, what the franchisee does (accept → enter Vonigo creds), and how to verify they landed correctly.
