# QA Test Plan — v5.73.0 — Backup Schedule tools (search, detail, export, bulk email)

Builds on v5.72.0 (the Backup Schedule board). New in v5.73.0: **search/filter**, **click-into detail card**, **CSV export**, and **bulk email selected jobs to crew**. Also: the importer now captures **customer phone + email** (from the Vonigo Contact record), so the detail card's call/text/email links have real data. Risk tier: **MEDIUM-HIGH**.

**Environment:** `https://dev.crewlogic.pages.dev` (dev Supabase). #90 has ~7 days of mirror data (Jul 22–30, 2026) with phone+email on every job.

## Conventions (same as before)
- **Fresh incognito window** per login test. Console (F12) banner must read **`v5.73.0`** (hard-refresh if not).
- **This screen needs a REAL login, not the 🔧 dev-bypass.** Sign in as **charles.dennis@junkluggers.com** (Google or magic link — paste the magic link into the same window's address bar, don't click it).

---

## Test 1 — Search / filter
1. Open **📅 Backup Schedule** (real login). → the board lists jobs by day.
2. In the **search box** at the top, type a customer surname you can see (e.g. **Reber**). → **Expected:** the list narrows to matching jobs as you type.
3. Clear it, type a route code (e.g. **MA1REG** or **Route 1**). → **Expected:** only that route's jobs show.
4. Type a date fragment (e.g. **Jul 30**). → **Expected:** only that day's jobs.
5. Clear the box. → **Expected:** full list returns.

**Pass / Fail: ____  Notes:**

## Test 2 — Click-into detail card (+ clickable fields)
1. Tap any job row (not the checkbox). → **Expected:** a detail card opens over the screen with: Stop • route • **Job #### (Vonigo link)**, day · time · status, **Job Total** (green, if priced), customer, 📍 address, 📞 phone, 💬 Text, ✉️ email (if the customer has one), 👷 crew, Items.
2. Tap the **📍 address** → **Expected:** opens Google Maps **directions** to that address (new tab).
3. Tap **📞 phone** → **Expected:** your device offers to **call** that number. Tap **💬 Text** → offers to **SMS** it.
4. Tap **✉️ email** (on a job that has one) → **Expected:** opens a new email to that address. (Jobs whose customer has no email simply won't show the ✉️ line — that's correct.)
5. Tap the **Job #### Vonigo link** → **Expected:** opens that job in Vonigo (new tab).
6. Close the card (× or tap outside). → **Expected:** returns to the list.

**Pass / Fail: ____  Notes:**

## Test 3 — CSV / Excel export
1. (Optional) apply a search filter first.
2. Tap **⬇ Download**. → **Expected:** a file `backup-schedule-YYYY-MM-DD.csv` downloads.
3. Open it in Excel/Numbers. → **Expected:** columns **Date, Time, Customer, Phone, Address, Route, Status, Amount, Job#**, one row per job shown, values correct. If you filtered first, only the filtered rows are in the file.

**Pass / Fail: ____  Notes:**

## Test 4 — Bulk email selected → crew
1. Tick the **checkboxes** on 2–3 jobs. → **Expected:** the **✉ Email selected** button enables and shows the count; ticking a checkbox does NOT open the detail card.
2. In the **"Send to:"** field, confirm/enter a recipient email (defaults to your address).
3. Tap **✉ Email selected**.
   - **On dev this will likely say "Couldn't send"** — that's expected: the dev environment has **no email key**. The selection, recipient validation, and body assembly are what you're checking here; actual delivery is verified on prod (or tell me and I'll enable email on dev — see below).
4. Enter a bad email (e.g. `abc`) and send → **Expected:** "Enter a valid email address," no send.

**Pass / Fail: ____  Notes:**

## Test 5 — No regressions
1. The base board still shows the live/down **banner** and day-grouped list (v5.72.0 behavior intact).
2. From Home, existing tiles (Estimates, Price Lookup, Coupon Lookup) still open normally.

**Pass / Fail: ____  Notes:**

---

## Want to test the actual email on dev?
Dev has no Resend key, so bulk-email delivery can't be exercised on dev by default. If you want to see the email land during dev testing, tell me and I'll set the Resend key on the dev project (I'll need you to confirm using the same key). Otherwise we verify delivery on prod after promotion.

## After this passes
Prod promotion: canonical model (0052–0055) + 0068/0069 + the functions to prod, then the **chunked** 6-month backfill (contact fetches are per-customer, so it runs in per-day/month batches to stay within the function time limit), then merge dev→main for the UI.
