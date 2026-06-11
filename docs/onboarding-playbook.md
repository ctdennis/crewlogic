# Onboarding Playbook — CrewLogicAI

_Created 2026-06-11. How to onboard a new user end-to-end, and how to verify they landed correctly.
Written to be executed cold. Pairs with the provisioning rules in
[`provisioning-access-matrix-spec.md`](provisioning-access-matrix-spec.md)._

---

## Pick the right path first

Two switches decide what a new user gets (full detail in the access-matrix spec):

- **Entry point → the clock:** a **guest-invite link** = never expires (`tester`); the **marketing site** (`crewlogicai.com`) = 14-day trial.
- **Email domain → CRM:** **`@junkluggers.com`** = Vonigo track; **any other domain** = native (no Vonigo).

So choose the playbook by who you're onboarding:

| Who | Playbook | Result |
|---|---|---|
| A **Junkluggers franchisee** (owner, `@junkluggers.com`) | **A** | Vonigo franchise in the Junkluggers tenant, never-expiring `tester` |
| A **non-Junkluggers operator** (owner, other domain) | **B** | Standalone native workspace (their own price book) |
| An **estimator** joining an existing franchise | **C** | Estimator profile under that franchise |

---

## Conventions (read once)

- **Incognito window:** open a *fresh* private/incognito window for any "accept as the new user" step, so it doesn't pick up your own logged-in session.
- **Magic-link / email-link rule:** copy the link out of the email and **paste it into the address bar of the *same* incognito window** — do **not** click it (clicking opens your default browser, not the incognito window).
- **Version check (optional):** open DevTools Console (Mac: ⌘+⌥+J) — the green banner shows the live version.
- **Who can generate what:** the **Guest Tester** invite is **super-admin only** (`charles.dennis@junkluggers.com`). The **estimator** invite (Team Members → + Invite) is available to any **owner** for their own franchise.
- **Where settings live:** the app is **app.crewlogicai.com**. Settings → **Account** tab holds Team Members + Guest Tester; Settings → **Vonigo Integration** is where Vonigo credentials are entered.

---

## Playbook A — Onboard a Junkluggers franchisee (Vonigo)

**Goal:** a `@junkluggers.com` owner ends up as a Vonigo-connected franchise in the shared Junkluggers tenant, with non-expiring `tester` access — same shape as Mark Harrington / Thomas Baldwin / Derek Watkins.

### A1. Owner generates the invite
1. Sign in to **app.crewlogicai.com** as **charles.dennis@junkluggers.com**.
2. **Settings → Account tab → "Guest Tester" card → "+ Generate".**
3. Copy the generated link (`https://app.crewlogicai.com/?invite=<token>`). Send it to the franchisee. *(Link is valid 14 days — that's the link expiry, not a trial clock.)*

> ⚠️ Use the **Guest Tester "+ Generate"** button — **not** the Team Members "+ Invite" (that's for estimators). A guest invite is `role=owner`, no franchise.

### A2. Franchisee accepts
4. The franchisee opens the link and **signs in with their `@junkluggers.com` Google account**.
5. **Expected:** they land in the app (no paywall, no blank screen), with a **"Setup needed"** badge on the Price Lookup tile. Behind the scenes they're provisioned **Vonigo-pending** (no throwaway tenant), with access via the never-expiring path.

### A3. Franchisee connects Vonigo (the one-time step)
6. **Settings → Vonigo Integration → enter their Vonigo username + password → Save.**
7. **Expected:** the app auto-discovers their Vonigo franchise, attaches it under the shared Junkluggers tenant, seeds the tool set, and flips them to a fully working Vonigo owner. The "Setup needed" badge clears.

### A4. Verify (ask the admin/assistant to run, read-only)
```sql
select p.email, p.role, f.external_id, t.name as tenant, t.crm_type,
       f.subscription_status, t.subscription_status as tenant_status,
       f.vonigo_configured
from profiles p
join franchises f on f.id = p.franchise_id
join tenants t on t.id = f.tenant_id
where lower(p.email) = '<franchisee-email>';
```
**Pass criteria:** `role=owner`; `tenant = The Junkluggers`; `crm_type = vonigo`; `external_id` = their real Vonigo franchise #; `vonigo_configured = true`; access resolves to `tester` (franchise `subscription_status` NULL → inherits tenant `tester`). **No paywall.**

---

## Playbook B — Onboard a non-Junkluggers operator (native)

**Goal:** an operator on any other email domain gets their own standalone native workspace.

**Two entry options:**
- **Marketing site (14-day trial):** send them to **crewlogicai.com** → "Start Free Trial" form (name / email / phone / business / territory) → they set a password on the app's "Create your account" screen → instant native `trialing` workspace.
- **Guest invite (never-expiring tester):** super-admin generates a Guest Tester link (A1); they accept with their non-junkluggers email → native `tester` workspace.

**Then they set up pricing:** Settings → **Price Book** → create a price list → **assign the towns/ZIPs they serve** (optionally toggle one list as the "covers all other ZIPs" catch-all). Until a price book exists, the estimate editor shows a "Set up Price Book" notice.

**Verify:** same query as A4 — expect `crm_type = none`, `external_id = native-xxxxxxxx`, a **separate tenant** named after their company, and `trialing` (marketing) or `tester` (guest invite).

> Email confirmation is **ON** in prod: a password signup sends a confirmation email first. **Tell them to check Junk/Spam** if it's not in the inbox — and see Troubleshooting.

---

## Playbook C — Add an estimator to an existing franchise

**Goal:** a crew member can log in and create estimates under an existing owner's franchise (using the owner's pricing).

### C1. Owner generates the estimator invite
1. Sign in as the **owner** of the franchise.
2. **Settings → Account tab → "Team Members" card → "+ Invite"** (green button).
3. Copy the link (`…/?invite=<token>`, valid 7 days) and send it to the estimator. *(This invite is `role=estimator`, scoped to your franchise.)*

> ⚠️ Use **Team Members "+ Invite"** — not the Guest Tester button (that would create a standalone owner workspace, not an estimator on your franchise).

### C2. Estimator accepts
4. Open the link in a fresh incognito window → enter their **name**, **email**, sign in.
   - **Junkluggers email:** signs in with Google.
   - **Other email:** uses the email sign-in link (magic-link rule above).
5. **Expected:** they land in the app with the **estimator** (non-owner) view and appear in the owner's **Team Members** list.

### C3. Verify
```sql
select p.email, p.role, f.external_id
from profiles p join franchises f on f.id = p.franchise_id
where lower(p.email) = '<estimator-email>';
```
**Pass:** `role = estimator`, `external_id` = the owner's franchise.

---

## Troubleshooting (real failure modes seen)

| Symptom | Cause | Fix |
|---|---|---|
| New user hits the **paywall** | Franchise `subscription_tier = 'free'` used to override the tenant's access status | Fixed in code v5.27.2 (gate grants if franchise tier **or** tenant status is an access value). If it recurs, confirm the tenant/franchise status; set the franchise to a tester/access value. |
| Owner sees **"No team members yet"** (not even themselves), or data looks empty | The browser's **Supabase auth session expired** — the app fell back to the anon key, so RLS returns nothing (it does **not** mean the data is gone) | **Sign out fully and sign back in.** Verify in Console: `(await supabaseClient.auth.getSession()).data.session ? 'REAL' : 'NONE'`. |
| Confirmation / sign-in email **not received** | Landed in **Junk/Spam** (the "Confirm signup" template, esp. while domain reputation warms) | Check Junk. DMARC/SPF/DKIM are configured + sender is `hello@crewlogicai.com`. If still missing, check the Resend dashboard for the send status. |
| Magic link "doesn't work" / opens the wrong window | The link was **clicked** (opened the default browser) instead of pasted | Paste the link into the **address bar of the same incognito window**; don't click. |
| Franchisee accepted but lands in a **blank native** workspace (no Vonigo) | They haven't done the **Vonigo Integration** step yet (A3), or a non-junkluggers email was used | Do A3 (enter Vonigo creds). If a non-junkluggers email was used, that's native by design — re-invite with their `@junkluggers.com` Google account. |
| Used the **wrong invite button** | Guest Tester = standalone owner; Team Members = estimator on your franchise | Use the matching button (A1 vs C1). If someone landed wrong, an admin can repoint the profile (`UPDATE profiles SET role=…, franchise_id=…`) and clean up the stray tenant via `admin_delete_tenant()`. |

---

## Notes for the admin
- Read-only prod checks run via `bash supabase/dev-setup/prod-readonly-sql.sh "<SELECT …>"`.
- Cleanup of a stray/test tenant: `admin_delete_tenant('<tenant-uuid>'[, delete_auth])` (gated prod write; dry-run first). See [[account-ctdennis-double-provisioned]] memory.
- The matrix's cell #4 (a `@junkluggers.com` person coming through the **marketing** site) routes them to Google and self-provisions a Vonigo-pending profile with a 14-day clock that starts at signup; they still complete A3 to connect Vonigo. Most Junkluggers onboarding should use **Playbook A** (guest invite → never-expiring), not the marketing funnel.
