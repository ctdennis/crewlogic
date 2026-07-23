# QA Test Plan — v5.72.0 — Backup Schedule (Vonigo DR board)

**What shipped:** a new **Backup Schedule** home tile + screen that shows your Vonigo jobs mirrored into CrewLogic (via `crewlogic-jobs`), with a banner telling you whether Vonigo is live or down. Reads only — it never changes Vonigo. Risk tier: **MEDIUM-HIGH** (new screen + customer data read + auth).

**Environment:** `https://dev.crewlogic.pages.dev` (dev Supabase). The dev DB has a 7-day mirror imported for **franchise #90** covering ~Jul 22–30, 2026, so there is real data to see.

## Conventions (read once)
- **Fresh window:** open a new incognito/private window for each login test so you're not carrying a stale session.
- **Version check:** open the browser Console (F12) — the startup banner should read **`v5.72.0`**. If it says v5.71.1, the Cloudflare build hasn't finished; wait ~1 min and hard-refresh.
- **IMPORTANT — this screen needs a REAL login, not the dev bypass.** The 🔧 "Dev sign-in · Vonigo #90" button sets you up WITHOUT a Supabase auth session, and this screen requires one. So:
  - To see the board: sign in for real as **charles.dennis@junkluggers.com** (Google, or the **magic link** on the login screen).
  - Magic-link rule: copy the link from the email and **paste it into the address bar of the same window** — do not click it (clicking opens your default browser, not this window).
  - If real login on dev isn't working for you, STOP and tell me — I'll enable a quick verified path so we can confirm before prod.

---

## Test 1 — Board renders with the live banner (real login)
**Precondition:** signed in for real as charles.dennis@junkluggers.com on dev (not the dev-bypass button).
1. On the Home screen, find the **📅 Backup Schedule** tile. → **Expected:** the tile is present.
2. Tap it. → **Expected:** the screen opens, titled "Backup Schedule", back button visible.
3. Look at the banner at the top. → **Expected (Vonigo is currently up):** a green **"✅ Vonigo is live — this is a backup copy (last checked H:MM AM/PM)"**.
4. Look at the list below. → **Expected:** jobs grouped by day (day headers like "Tue, Jul 28"), each row showing a time, a customer name, a 📍 address, a 🚚 route, a status badge, and a 💰 amount when present.

**Pass / Fail: ____   Notes:**

## Test 2 — Known rows are correct
With the board open (Test 1), find these specific rows:
1. **Wed, Jul 30 → Pimental, Teresa** → **Expected:** Route 3 (MA3ALL), **$249.00**, status **Scheduled**.
2. **Wed, Jul 30 → Surya, Yash** → **Expected:** Route 1 (MA1REG), Scheduled (no amount is fine).
3. **Tue, Jul 28 → Ercanbrack, Kathy** → **Expected:** shown **dimmed with a line through it** and a **Cancelled** badge.
4. **Tue, Jul 28 → Gleicher, Mark** → **Expected:** Scheduled, Route 1.

**Pass / Fail: ____   Notes:**

## Test 3 — No-session guard (dev bypass)
1. Open a **fresh** window, go to dev, and click the **🔧 Dev sign-in · Vonigo #90** button (the bypass).
2. Open **Backup Schedule**. → **Expected:** instead of the board, a message: **"Backup Schedule needs a full login. The dev bypass has no session — sign in with email/Google to view it."** (This is correct — it proves the screen won't leak data without a real, franchise-scoped session.)

**Pass / Fail: ____   Notes:**

## Test 4 — No regressions on existing tiles
Still on dev, from Home tap each of these and confirm each opens normally (then back out):
1. **Estimates** 2. **Price Lookup** 3. **Coupon Lookup** 4. **Where Are My Trucks?** (if visible)
→ **Expected:** all open exactly as before; the new tile didn't disturb anything.

**Pass / Fail: ____   Notes:**

---

## Not covered here (by design)
- **Down-banner state:** the amber "⚠️ Vonigo is DOWN — showing last-known schedule…" banner appears automatically only when the health monitor has recorded 3 consecutive failed checks. We won't force a real outage to test it; the logic was validated separately on dev (forced-down: strikes 1–2 quiet, strike 3 flips).
- **Full 6-month history:** dev currently holds only a ~7-day import. The full backfill runs on prod after promotion.
- **crew names / phone / email:** crew shows once assigned near a job's day; phone/email are a follow-up (Vonigo field IDs).

## After this passes
Promote to prod: push the canonical model (migrations 0052–0055, 0068, 0069) + the functions to prod, run the full 6-month backfill for all 9 franchises, then merge dev→main for the UI.
