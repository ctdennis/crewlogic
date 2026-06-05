# QA Test Plan — CrewLogicAI v5.25.0

**Environment:** Production — `https://crewlogicai.com`
**Build under test:** `v5.25.0`
**Date executed:** ____________  **Executed by:** ____________

## Test accounts (prod)
| Label | Email | How it signs in | Role / workspace |
|---|---|---|---|
| **Owner-Vonigo** | `charles.dennis@junkluggers.com` | Google | Owner of franchise **#90** (Vonigo) |
| **Owner-Native** | `tpass2008@gmail.com` | Google **or** email link | Owner of native franchise **`native-74f86026`** |
| **Estimator** | `crewlogictest@gmail.com` | Google **or** email link | **Estimator** under `native-74f86026` |

> You need access to the inbox for `tpass2008@gmail.com` and `crewlogictest@gmail.com` to read the email sign-in links.

## Conventions used below
- **"Open Incognito"** = in Chrome, `Cmd+Shift+N` (Mac) / `Ctrl+Shift+N` (Win) opens a new private window. Use a **fresh** incognito window each time a step says "Open Incognito" (close any previous one first) so no old session carries over.
- **"Open the Console"** = press `F12` (or `Cmd+Option+J` on Mac Chrome) and click the **Console** tab.
- **"Paste the sign-in link into the same window"** = copy the link from the email, click the address bar of *that same window*, paste, press Enter. **Do not click the link in the email** — clicking opens your default browser, not the incognito window.
- A test **PASSES** only if the "Expected" line is exactly what you see. Note anything different under "Notes."

---

## TEST 0 — Confirm you're on v5.25.0 (do this first, in every window you test in)
1. Open `https://crewlogicai.com`.
2. Hard-refresh: `Cmd+Shift+R` (Mac) / `Ctrl+Shift+R` (Win).
3. Open the Console (`F12` → Console tab).
4. Look for a green badge log line near the top.
- **Expected:** it reads **`CrewLogic v5.25.0 | 2026-06-04`**. If it still says v5.24.x, wait 60s, hard-refresh again.
- x Pass ☐ Fail — Notes: ____________

---

## TEST 1 — Vonigo owner Google login still works (regression)
**Why:** v5.25.0 changed how Google sign-in works; confirm the existing owner is unaffected.
1. Open Incognito → go to `https://crewlogicai.com`.
2. On the "How would you like to sign in?" screen, click **Continue with Google**.
3. In the Google account chooser, click **`charles.dennis@junkluggers.com`**. Complete Google if prompted.
4. Wait for the app to load.
- **Expected:** You land on the **Home** screen ("Good [morning/afternoon], …"). Tap **Estimates** → the estimates list loads with existing estimates (not empty, no error).
- x Pass ☐ Fail — Notes: ____________

---

## TEST 2 — Estimator Google login now gets a working session (the #59 fix — most important)
**Why:** Before v5.25.0, signing in via Google gave the estimator no real session, so they saw 0 customers and couldn't save. This must now work.
1. Open a **fresh** Incognito window → `https://crewlogicai.com`.
2. Click **Continue with Google**.
3. In the Google chooser, click **`crewlogictest@gmail.com`** (shows as "Skip Dennis"). Complete Google if prompted.
4. Wait for the app to load. (Expected: lands on Home, **not** a "Something went wrong" or "Name your workspace" screen.)
5. Tap **Estimates** → tap **+ New**.
6. In the customer search box, type **`a`** (just to trigger a search of existing customers).
- **Expected A:** A list of customer names appears (there are 81 customers on this workspace). *Before the fix this returned nothing.*
7. Pick any customer from the list (or if you prefer, complete a quick estimate). Add one item: tap **Manual ▾ → add a line** (any item), then tap **Save Draft**.
- **Expected B:** It saves — the feedback shows saved (no error), and the draft appears in the Estimates list when you go back.
- x Pass ☐ Fail — Notes: I pulled up a zip that hadn't been set up yet and the error message said to speak with my administrator vs defaulting to the default price list. was this expected behavior?

> If Test 1 or Test 2 fails (Google login dead-ends, "Something went wrong," or still no customers): **stop and report.** Fallback that still works: sign in with **Continue with email** instead (see Test 2-ALT).

### TEST 2-ALT — Estimator email login (fallback / comparison)
1. Fresh Incognito → `https://crewlogicai.com` → **Continue with email**.
2. Type `crewlogictest@gmail.com` → click **Email me a sign-in link**.
3. Open the `crewlogictest@gmail.com` inbox, find the CrewLogic sign-in email, **copy** the link.
4. Switch back to the incognito window, paste the link into the **address bar**, press Enter.
- **Expected:** Lands in the app as the estimator; customer search and Save work (same as Test 2).
- ☐ Pass ☐ Fail — Notes: didn't need to test this

---

## TEST 3 — Sign-out actually signs you out (#55)
**Precondition:** You are signed in (use the window from Test 1 or Test 2).
1. Tap **⚙ Settings** (top-right).
2. Scroll to the bottom → tap **Sign out** → confirm **OK** on the "Sign out of CrewLogic?" prompt.
- **Expected:** You return to the login screen.
3. Now **refresh the page** (`Cmd+R` / `Ctrl+R`).
- **Expected:** You **stay on the login screen** (you are NOT silently logged back in). *Before the fix, refresh logged you back in.*
- x Pass ☐ Fail — Notes: ____________

---

## TEST 4 — Estimator sees a role-appropriate "no pricing" message (#60)
**Why:** Estimators can't set up price books, so they must not see a "Set up Price Book" button or reach that screen.
**Precondition:** Signed in as **Estimator** (`crewlogictest@gmail.com`). The workspace's Default price list is empty (so an unmapped ZIP can't price). If the owner has since filled the Default list, pick a customer whose town is *not* one of the priced ZIPs.
1. Tap **Estimates → + New**.
2. Search and select a customer **whose ZIP is not in the price book** (i.e., not a Plymouth-area ZIP). If unsure, use any customer; the goal is to land on an estimate that can't price.
3. Look at the orange notice near the top of the estimate.
- **Expected A:** It reads **"Pricing isn't set up yet … Ask your owner or admin to finish the price book…"** and there is **NO "Set up Price Book" button**.
4. Tap **⚙ Settings**.
- **Expected B:** You see only the **Account** view. There is **no Price Book tab**, and you cannot reach a price-book setup screen.
- x Pass ☐ Fail — Notes: ____________

---

## TEST 5 — Owner sees the empty-default warning + item counts (#56)
**Precondition:** Signed in as **Owner-Native** (`tpass2008@gmail.com`).
1. Tap **⚙ Settings** → tap the **Price Book** tab.
2. Look at the list of price lists.
- **Expected A:** Each list shows an item count, e.g. **"Tpass Price List 1 … (0 items)"** and **"Tpass Price List 2 … (58 items)"** (counts may differ if you've edited them).
- **Expected B:** If the list marked **DEFAULT** has **0 items**, an **orange warning banner** appears above the lists saying the Default list has no priced items and won't price ZIPs until you add items (or "Make default" on a list that has prices).
- **Expected C (single list only):** If there is exactly **one** list, a grey hint appears saying a single list is the catch-all for every ZIP.
- x Pass ☐ Fail — Notes: need the ability to copy a price list. add to status.md

---

## TEST 6 — Price Lookup shows a friendly notice, not a raw error (#50)
**Precondition:** Signed in as **Owner-Native** (`tpass2008@gmail.com`) **with the Default price list empty** (as in Test 5). If you've since added pricing to the Default list, this test will instead return prices (also fine — note that).
1. From Home, tap **Price Lookup**.
2. Make sure the **ZIP** toggle is selected (not Town). In the ZIP field type a 5-digit ZIP that is **not** in the price book, e.g. **`02726`** → tap **Look up**.
- **Expected:** An **orange "No price book set up yet / Set up Price Book"** notice appears (with a **Set up Price Book** button, because you're an owner). You do **NOT** see the raw text *"No default price list configured for this franchise."*
- ☐ Pass x Fail — Notes: the default price list still has no zips assigned. when I type the town that is not associated with a zip, I get an error message: Town not found in your service area — try the ZIP. The whole point of the town lookup is that I don't know the zip. I thought this was going to lookup the town and pull the default price list?

---

## TEST 7 — "Upon Completion" payment term (#54)
**Precondition:** Signed in as any **owner**, in an estimate that **has at least one charge** (so it has a dollar total).
1. Open an estimate with a total > $0 (or build one: **Estimates → + New →** add a Manual item).
2. Scroll to the **SPECIAL TERMS** section → if collapsed, tap to expand it.
3. In **Down payment**, choose **%** and type **`50`**.
4. In the **Balance due within** dropdown, select **Upon Completion**.
- **Expected A (preview):** The grey preview line under the fields ends with **"… due upon completion"**.
5. Generate the customer PDF (the **More ▾ → Generate PDF** / PDF option), open it.
- **Expected B (PDF):** On the cover page, the **PAYMENT SCHEDULE** shows the deposit line and **"Balance (due upon completion)."**
6. Tap **Save Draft**, leave the estimate, reopen it, expand Special Terms.
- **Expected C (persistence):** "Balance due within" still shows **Upon Completion**.
- x Pass ☐ Fail — Notes: 

---

## TEST 8 (optional) — Fresh estimator invite end-to-end via Google
**Why:** Validates the full invite→accept→Google path with the new native session, on a brand-new email.
**Precondition:** You have a brand-new Gmail address with **no** CrewLogic account yet (e.g. create `crewlogictest2@gmail.com`). Signed in as **Owner-Native** (`tpass2008@gmail.com`).
1. As the owner: **⚙ Settings** → find the **Team Members** card → tap **+ Invite**.
2. A panel appears with an invite link → tap **Copy**.
3. Open a **fresh** Incognito window → paste the invite link into the **address bar** → Enter.
- **Expected:** A "You've been invited to join a team" screen with **Continue with Google** / **Continue with email**.
4. Click **Continue with Google** → choose the brand-new Gmail account.
- **Expected:** It signs in and lands in **tpass2008's** workspace as an **estimator** (same customers/price book), **not** a new workspace, and customer search + Save work.
- x Pass ☐ Fail — Notes: ____________

---

## Summary
| Test | Result | Notes |
|---|---|---|
| 0 — Version v5.25.0 | ☐ | |
| 1 — Vonigo owner Google login | ☐ | |
| 2 — Estimator Google session | ☐ | |
| 2-ALT — Estimator email session | ☐ | |
| 3 — Sign-out | ☐ | |
| 4 — Estimator role-gating | ☐ | |
| 5 — Empty-default warning | ☐ | |
| 6 — Price Lookup notice | ☐ | |
| 7 — Upon Completion | ☐ | |
| 8 — Fresh Google invite (optional) | ☐ | |

---

# v5.26.0 addendum — Explicit + optional catch-all pricing model

**Build under test:** `v5.26.0` (confirm via the Console banner — same as Test 0). Uses the **accounts** and **conventions** from the top of this doc. Signed in as **Owner-Native** (`tpass2008@gmail.com`) unless a step says otherwise.

> New model: a ZIP must be **assigned to a price list**, OR a list must be marked **"covers all other ZIPs"** (the catch-all). An unassigned ZIP with no catch-all → "not set up."

## TEST 26-A — A new price list is NOT auto-catch-all
1. Sign in as Owner-Native → tap **⚙ Settings** → tap the **Price Book** tab.
2. Tap **+ Add Price List**, type `ZZ Test`, press OK.
- **Expected:** "ZZ Test" appears with **no CATCH-ALL badge**, shows **(0 items, 0 ZIPs)**, and has a **"Covers all ZIPs"** button (not "Make default").
- ☐ Pass ☐ Fail — Notes: ____________

## TEST 26-B — Toggle a list to catch-all and back
1. On the "ZZ Test" row, tap **Covers all ZIPs**.
- **Expected:** "ZZ Test" gets a green **CATCH-ALL** badge, its button becomes **✓ Catch-all**, and its **Zips** button disappears. Any list that was previously catch-all loses its badge.
2. Tap **✓ Catch-all** again.
- **Expected:** The badge is removed and the **Zips** button reappears.
- ☐ Pass ☐ Fail — Notes: ____________

## TEST 26-C — Assign ZIPs to a list
1. On a non-catch-all list, tap **Zips** → in the add box type `02726` → add it → close the popup.
- **Expected:** That list's count updates to include the ZIP, e.g. "(… , 1 ZIP)."
- ☐ Pass ☐ Fail — Notes: ____________

## TEST 26-D — The two warning banners
1. Mark a list that has **0 items** as the catch-all (e.g. your empty "Tpass Price List 1" → tap **Covers all ZIPs**).
- **Expected A:** An orange banner above the lists: *"Your catch-all list (…) has no priced items…"*.
2. Tap **✓ Catch-all** to turn it off, and make sure **no** list has any ZIPs assigned (remove them if needed).
- **Expected B:** An orange banner: *"Nothing will price yet. Assign the towns/ZIPs you serve…"*.
- ☐ Pass ☐ Fail — Notes: ____________

## TEST 26-E — Unassigned-ZIP message: owner vs estimator
**Precondition:** no catch-all set, and ZIP `02726` not assigned to any list.
1. As **Owner-Native**: tap **Estimates → + New** → search/select a customer in ZIP `02726`.
- **Expected (owner):** Orange notice *"This area isn't priced yet … assign this ZIP to a price list — or mark a list 'covers all other ZIPs'"*, **with** a **Set up Price Book** button.
2. Open a fresh Incognito, sign in as **Estimator** (`crewlogictest@gmail.com`), open the same kind of unpriced estimate.
- **Expected (estimator):** *"This area isn't priced yet — ask your owner or admin,"* with **no** button.
- ☐ Pass ☐ Fail — Notes: ____________

## TEST 26-F — Town lookup for an unassigned town
1. As Owner-Native → Home → **Price Lookup** → tap the **Town** toggle → type a town whose ZIP you have **not** assigned → **Look up**.
- **Expected (owner):** *"That town isn't assigned to a price list yet. Add it in Settings → Price Book…"* (and it does **not** say "try the ZIP").
- ☐ Pass ☐ Fail — Notes: ____________

## TEST 26-G — Happy path: set it up, it prices
1. As Owner-Native: either mark **"Tpass Price List 2"** (58 items) as the **catch-all**, or assign your service ZIPs to it (the Zips button).
2. Tap **Estimates → + New** → select any customer → look at the toolbar + quote.
- **Expected:** Pricing loads (no warning banner), the Photo/Describe/Manual/More buttons are active, and the quote prices normally. Re-run Price Lookup / Town for one of those ZIPs/towns and confirm it returns prices.
- ☐ Pass ☐ Fail — Notes: ____________
