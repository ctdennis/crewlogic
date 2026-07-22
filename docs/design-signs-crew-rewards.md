# Yard-sign crew rewards via PromoVault — design (REMOVED from the CrewLogic UI 2026-07-21)

**Status:** removed from the app, design preserved here.
**Why:** the integration does not work, and testers were running into it. Owner 2026-07-21:
"remove all references to promo vault from crewlogic but store the design… This cannot be visible."
**Tracker:** `.HUB/Hub.md` → FW-55.
**Recover the exact code:** `git show <this commit>^:index.html` — the removal commit message names
the line ranges. Nothing was rewritten; the blocks were lifted out whole.

---

## 1. What it did

Crew earn a **credit** per yard sign placed. When a crew member's unconsumed credits reach a
threshold, CrewLogic issues them a **gift-card reward** through **PromoVault** (Promotion Vault,
`api3.promotionvault.com`) Quick Send. The crew member gets a link; the credits are marked consumed.

Flow:

1. A signs session ends → `checkAndIssueRewards(crewIds)` runs per crew member.
2. Count that crew member's `sign_credits` rows where `consumed_by_reward IS NULL`.
3. If count >= `creditsPerReward` (default 25), insert a `sign_rewards` row
   (`status: 'pending'`, `reward_amount_dollars` default 10, `test_mode` per config).
4. PATCH the consumed `sign_credits` rows with `consumed_by_reward = <reward id>`.
5. Fire-and-forget `deliverRewardViaEdge(rewardId)` → `crewlogic-ai` action `issueReward`.
6. The edge function loads the reward + crew + franchise signs config, calls PromoVault
   Quick Send, and writes back `status` / `promovault_reward_id` / `reward_link` / `issued_at`,
   or `error_message` on failure.

Credit consumption happened at step 4, BEFORE delivery was confirmed at step 6. That ordering is
one of the reasons a broken PromoVault was visible to testers: credits were spent and the reward
then failed, leaving a `sign_rewards` row stuck in `pending`/`failed` with the credits already gone.

## 2. Configuration (Settings → Signs)

Stored in `franchises.cost_settings.signs`:

| Key | Default | Purpose |
|---|---|---|
| `graySignDays` | 15 | sign ages to gray — **KEPT, unrelated to rewards** |
| `hiddenSignDays` | 60 | sign hidden — **KEPT, unrelated to rewards** |
| `creditsPerReward` | 25 | credits needed to earn one reward |
| `rewardAmountDollars` | 10 | dollar value of the reward |
| `promoVaultApiKey` | — | per-franchise PromoVault key |
| `promoVaultTeamId` | — | PromoVault team the reward is billed to |
| `signsTestMode` | true | write the reward row but do NOT call PromoVault |

The UI also listed **Recent Rewards** with status, error message and a per-row **Retry** button —
the most directly tester-visible surface, because a failing integration showed as a list of errors.

## 3. Backend — NOT removed, but now unreachable

Left in place deliberately; none of it is visible to a tester and removing it means editing
`crewlogic-ai`, which does a great deal else:

- `supabase/functions/crewlogic-ai/index.ts` — action `issueReward`, `PROMOVAULT_BASE =
  'https://api3.promotionvault.com'`, POST `/quick-send/`, 25s timeout, test-mode short-circuit
  that fabricates a fake reward id.
- Secret `PROMOVAULT_API_KEY` (master, multi-team scope).
- Tables `sign_rewards` (incl. `promovault_request` / `promovault_response` /
  `promovault_reward_id` / `reward_link` / `error_message`) and `sign_credits.consumed_by_reward`.

With the frontend call sites gone, `issueReward` has no caller.

**DECIDED 2026-07-22: leave all of it in place, including the `PROMOVAULT_API_KEY` secret.** Owner:
*"stop asking me to sunset the promo vault api key. Leave it there, we will pick it up again and it
harms nothing having it resting there for now."* The feature is coming back, so tearing the backend
out only creates work to rebuild it. Do not re-propose removing the secret, the `issueReward`
action, or the `sign_rewards` columns.

## 4. Where this is going instead

`docs/plan-yardsign-split.md` already records the intended production model, and it is NOT the
model implemented here:

> Rewards — LEFT OUT of v1. It only works in test today and the production model isn't fleshed
> out. Future prod model: the *customer* enters their own credit-card / account on PromoVault and
> configures rewards **there**; Yard Sign AI is only responsible for maintaining the connection to
> their PromoVault account (bring-your-own-account integration, not us funding/reselling rewards).

So the removed implementation — CrewLogic holding a master API key and issuing rewards on the
franchise's behalf — is the wrong shape for production regardless of whether it worked. That plan
also calls for abstracting PromoVault behind a rewards-provider interface rather than hardwiring it.

**If this is rebuilt, do not restore it as-is.** Two things to change:

1. **Bring-your-own-account**, per the plan above — no master key held by us.
2. **Consume credits only after delivery is CONFIRMED**, not before. The current ordering spends
   credits on a reward that may never arrive.

## 5. What was removed from `index.html`

- `checkAndIssueRewards()` and its call site in the signs-session end handler
- `deliverRewardViaEdge()`
- `loadRecentRewards()` and `retryReward()`
- The **Credits & Rewards**, **PromoVault** and **Recent Rewards** blocks of `renderRewardsMgmt()`
  (Sign Lifecycle retained)
- The reward/PromoVault keys in `saveSignsConfig()`
- The word "PromoVault" from the Settings → Signs description text

Existing `cost_settings.signs` values for the removed keys are left untouched in the database —
they are simply no longer read or written. Nothing is migrated or deleted, so a rebuild can pick
them back up.
