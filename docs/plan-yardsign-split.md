# Plan — Yard Signs Split-off (standalone app + CrewLogic SSO hand-off)

**Status:** APPROVED (Owner, 2026-07-07). Executing by phase. Decisions resolved below.
**Owner:** charles.dennis@junkluggers.com
**Author:** Claude (master session)
**Related:** the CrewLogic yard-signs feature map (2026-07-05 recon); `docs/plan-payments.md` (CrewLogic billing); the Blue Collar Technology umbrella (`bluecollartechai.com`).

## Goal

Turn the CrewLogic "yard signs" feature into a **standalone product** — **Yard Sign AI** at **yardsignai.com**, on its own domain, tech stack, auth, and billing, with its own independent marketing site. It is reachable two ways:

1. **From inside CrewLogic** — the Yard Signs tile stays, but clicking it **hands the user off (new tab, one-click SSO)** to the standalone app; a "← Back to CrewLogic" control returns them.
2. **Independently** — anyone can sign up + subscribe at yardsignai.com directly, with **no CrewLogic affiliation**.

## Decided (this session, Owner)

- **Standalone app**, not embedded. **iframe rejected** (cross-origin auth / third-party-cookie fragility, mobile/back-button jank, and it contradicts the independent-domain/billing goal).
- **New-tab SSO hand-off.** CrewLogic acts as an **identity provider (IdP)**; Yard Signs is the **relying party (RP)**.
- Keep the CrewLogic **tile** as a launcher; make switching back trivial.

## Architecture overview

```
  CrewLogic (crewlogicai.com)                 Yard Sign AI (yardsignai.com)
  ┌───────────────────────────┐               ┌───────────────────────────────┐
  │ Yard Signs tile           │  new tab →    │ /sso?token=<JWT>              │
  │  └ mint short-lived JWT ──────────────────▶│  verify → find/create user    │
  │     (identity+entitlement)│               │  → set session → open app     │
  │                           │  ◀── "← Back to CrewLogic" link ──            │
  └───────────────────────────┘               │ Independent signup + Stripe   │
                                              │ Own Supabase (companies/tenancy)│
                                              │ Marketing site (no CL branding) │
                                              └───────────────────────────────┘
```

## Components

### 1. Yard Sign AI app (standalone)
- **Own domain** yardsignai.com, **own repo**, **own Supabase project** (isolation: own auth, tenancy, storage bucket, billing).
- **Ported from CrewLogic's yard-signs feature** (highly self-contained per the recon): 5-table cluster (`yard_signs`, `sign_sessions`, `sign_credits`, `sign_rewards`, `sign_status_events`), the `signs_daily_lifecycle()` SQL + lifecycle cron, and ~2.2k lines of contiguous UI (place → photo → AI-verify → GPS → track → credits/leaderboard). Business rules are already config-driven with generic defaults.
- **Generalize** (industry-agnostic, per the recon): rename `franchise_id` → `company_id`/`org_id`; reword the one junk-removal sentence in the AI detect prompt; bring along `campaigns` + `crew_members`; dedicated storage bucket (today it shares CrewLogic's `estimate-photos`); own Anthropic + Google keys.

### 2. SSO hand-off contract (the core new piece)
- **Tile click → CrewLogic edge fn `crewlogic-signs-sso`** mints a **short-lived JWT** (recommend HS256 shared secret for v1; asymmetric EdDSA/RS256 is the hardening upgrade so the RP can't mint). Claims: `sub` (CrewLogic user id), `email`, `name`, `company` (franchise/tenant + display name), `entitlement:"yardsigns"` (proof of access), `origin:"crewlogic"`, `iat`, `exp` (~2 min — one-time hand-off).
- **CrewLogic only mints if the user's subscription tier includes Yard Signs** (see Entitlement).
- **New tab → `yardsignai.com/sso?token=<jwt>`.** Yard Signs verifies signature + `exp` + `entitlement`, **find-or-creates** the Yard Signs company/user (auto-provision on first visit), sets its own session, redirects into the app.
- **`origin:"crewlogic"` claim → Yard Signs renders the "← Back to CrewLogic" header button** (only for CrewLogic-originated users; independent users don't see it).

### 3. Entitlement + access (the two front doors)
- **CrewLogic subscribers:** their CrewLogic **subscription tier** grants the Yard Signs entitlement, asserted in the SSO token. Yard Signs trusts it. (Which tiers include Yard Signs = an Open Decision, ties to `plan-payments.md`.)
- **Independent subscribers:** normal email/password signup + **own Stripe subscription** on yardsignai.com. Same app, different door.
- Yard Signs enforces access from **either** source at its own gate.

### 4. Billing
- Yard Signs has its **own Stripe** (products/prices/webhook) for independent subs. CrewLogic-entitled users don't pay Yard Signs (their CrewLogic plan covers it).
- Reuses the CrewLogic billing patterns (`plan-payments.md`) but in the Yard Signs project.

### 5. Marketing site (yardsignai.com)
- Independent landing page — own brand, "Start free / Sign in", **no CrewLogic affiliation**. Same lightweight static approach as the Blue Collar Technology site. Can go up early (domain lands on something) ahead of the app.

### 6. CrewLogic-side changes (small, additive)
- The Yard Signs **tile** `onclick` → call `crewlogic-signs-sso` → `window.open('https://yardsignai.com/sso?token=…','_blank')`.
- New edge fn **`crewlogic-signs-sso`** (mint the JWT; gate on tier). No change to the existing in-CrewLogic signs screens until cutover (they can stay as a fallback during migration, then be removed).

## Junkluggers data migration
Junkluggers' existing yard-signs data lives in CrewLogic's Supabase today. Once the tile hands off to the standalone app, Junkluggers uses the standalone app → their signs/sessions/credits/rewards should live in the **Yard Signs** project. **One-time migration** of the yard_signs cluster (rescoped `franchise_id`→`company_id`) into the new project, with Junkluggers provisioned as the first company. (Alternative: start Junkluggers fresh in the new app — Owner's call.)

## Build phases (proposed)
1. **Marketing site** — yardsignai.com landing up (quick, like BCT).
2. **Yard Signs app skeleton** — new repo + Supabase project; independent auth (email/password) + tenancy (companies); Stripe wiring (dormant).
3. **Port the signs feature** — schema + edge fns + UI, generalized; own storage bucket + AI/maps keys.
4. **SSO hand-off** — `crewlogic-signs-sso` (CrewLogic) + `/sso` verify+provision (Yard Signs) + "← Back to CrewLogic"; wire the CrewLogic tile.
5. **Entitlement + independent billing** — CrewLogic tier→token gate; Yard Signs Stripe live.
6. **Junkluggers migration + cutover** — migrate data; flip the tile; retire the in-CrewLogic signs screens.

## Resolved decisions (Owner, 2026-07-07)
1. **Rewards — LEFT OUT of v1.** It only works in test today and the production model isn't fleshed out. **Future prod model (Owner):** the *customer* enters their own credit-card / account on **PromoVault** and configures rewards **there**; Yard Sign AI is only responsible for **maintaining the connection to their PromoVault account** (bring-your-own-account integration, not us funding/reselling rewards). Revisit as a later phase; keep a pluggable reward-provider seam so it drops in.
2. **Go-to-market — free beta first.** Stripe wired but dormant; tiers TBD later.
3. **Entitlement — the CrewLogic PRO tier includes Yard Signs.** (Pro-and-above; the SSO token is minted only for Pro-tier CrewLogic users.)
4. **Junkluggers data — migrate.** One-time migration of the yard_signs cluster into the new project; Junkluggers = first company.
5. **Token signing — HS256 shared secret** for v1 (asymmetric later as hardening).
6. **New repo + new Supabase project** for Yard Sign AI — yes (clean isolation). Marketing on the apex `yardsignai.com`, the app on `app.yardsignai.com` (mirrors CrewLogic).

## Risks / notes
- **Shared `crewlogic-ai` / `estimate-photos` coupling** must be cleanly split out of CrewLogic when porting (recon flagged these as the top coupling points).
- **Multi-tenant time zones** — apply the CrewLogic TZ discipline in the new app from day one (sign lifecycle, "today" logic).
- **PromoVault** hardwiring → abstract behind a rewards-provider interface.
- This SSO token contract is the **lightweight first piece of a shared "Blue Collar Technology" identity** — start clean here and it generalizes if more BCT apps follow, without building a full platform now.

## Approval
Owner to confirm the plan + the 6 Open Decisions. On approval, work proceeds by phase; each phase is a discrete, reviewable step (no big-bang).
