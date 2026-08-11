# QA Test Plan — v5.123.0 — Per-tab Setup access delegation + Team access totals

**Risk tier:** HIGH (access control — must not leak owner-only Settings or credentials to estimators). Test the *negative* cases (what a delegate must NOT see) as hard as the positive ones.
**Where:** `https://dev.crewlogic.pages.dev` (dev Supabase).
**What shipped:** Owners can now grant individual **Settings tabs** to a non-owner via the per-user **Access** editor (renamed from "Tiles"), and the owner's Team card shows an **access total**.

## Accounts (dev)
| Login | Role | How |
|---|---|---|
| Dev #90 owner | owner | 🔧 Dev sign-in · Vonigo #90 button on the dev login |
| A #90 estimator | estimator | (see setup below) |

**Setup a test estimator if none exists:** as the owner, Settings → Account/Team → invite an estimator, OR use an existing estimator profile under #90. The estimator must be able to sign in on dev (Google or magic link).

## Delegatable tabs (9): Franchise info, Cost, Proposal, Pricing, Price Book, Customers, Yard Signs, Tools, Routes.
## Never delegatable (owner-only): **Trucks** (telematics API tokens), **Vonigo credentials**, **Team management**, **Subscription/billing**.

---

## Test 1 — Owner still sees everything (regression) — HIGH
1. Sign in as **owner** → Settings.
2. Expected: **all** tabs present (Franchise, Cost, Proposal, Pricing, Price Book?, Customers?, Yard Signs, Tools, Trucks, Account, Routes), Vonigo Integration card visible, Team Members card visible. Nothing removed for the owner.

Pass/Fail: ___

## Test 2 — The Access editor shows the new Setup section — MED
1. Owner → Settings → Team Members card → click **Access** on an estimator row (button was "Tiles").
2. Expected: modal titled **"Access for <name>"**, with **two sections**: "Home screen tiles" (as before) and **"Setup access (Settings tabs)"** listing the 9 delegatable tabs, all **unchecked** by default.
3. Check **Cost** and **Routes** only → **Save access** → "Saved" confirmation.

Pass/Fail: ___

## Test 3 — Delegate sees ONLY granted tabs — HIGH
1. Sign in (fresh incognito) as that **estimator** → open Settings.
2. Expected: the Settings tab bar now shows **Account + Cost + Routes only**. No Franchise, Pricing, Proposal, Price Book, Customers, Yard Signs, Tools, **Trucks**.
3. Open **Cost** → it loads (facilities/cost settings). Open **Routes** → it loads.

Pass/Fail: ___

## Test 4 — Delegate CANNOT reach ungranted/owner-only surfaces — HIGH (the security test)
1. Still as the estimator with only Cost+Routes granted:
   - Confirm there is **no Trucks tab**, **no Vonigo Integration (credentials) card** anywhere, **no Team Members card**, **no Subscription/billing**.
   - Confirm **Franchise, Pricing, Proposal, Price Book, Customers, Yard Signs, Tools** tabs are **absent** (not just visually — they shouldn't be reachable).
2. Expected: none of the above are visible or reachable. (The tab guard also redirects any deep-link to Account.)

Pass/Fail: ___  **If any owner-only/credential surface is visible → STOP, this blocks release.**

## Test 5 — Revoke works — MED
1. Owner → Team → **Access** on that estimator → uncheck **Cost** (leave Routes) → Save.
2. Estimator: sign out/in (or reopen the app) → Settings now shows **Account + Routes only** (Cost gone).

Pass/Fail: ___

## Test 6 — Zero grants = legacy behavior — MED
1. Owner → Access on a *different* estimator → leave all Setup boxes **unchecked** → Save.
2. That estimator → Settings shows **only their Account** (no tab bar), exactly as before this release.

Pass/Fail: ___

## Test 7 — Team access total — LOW/MED
1. Owner → Settings → Team Members card.
2. Expected: a summary line at the top, e.g. **"N team members · 1 owner · M estimators · X with setup access"**, where **X** = how many estimators have at least one Setup tab granted. Grant/revoke a tab (Test 2/5) and confirm **X** updates on reload.

Pass/Fail: ___

## Test 8 — Tester not locked out (guardrail) — HIGH
1. Confirm a **tester** account can still sign in and reach the app (not the paywall). This change only affects *Settings-tab visibility for estimators*; it does not touch the subscription/access gate.

Pass/Fail: ___

---
### Notes
- Server: none. Uses the existing `profile_feature_toggles` table with new `cfg_<tab>` keys (no migration).
- Trucks-tab delegation (splitting fleet setup from the telematics API token) is a deliberate follow-up, not in this release.
