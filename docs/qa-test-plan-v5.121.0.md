# QA Test Plan — v5.121.0 — Follow-up Pipeline (P3: screen + Sequence builder)

**Risk tier:** MEDIUM (new screen; several data writes: stage / sequence-assign / touch Done / snooze / notes / sequence CRUD; multi-step flows; renders + saves → includes a mid-interaction step).
**Where:** `https://dev.crewlogic.pages.dev` (dev Supabase). Nothing pipeline-related is on prod yet.
**What shipped:** a **Follow-up Pipeline** Home card + screen that lists the 5 Vonigo ops types (leads, unconverted estimates, cancellations, urgent callbacks, cases) in ONE list, plus a **Sequence builder**.

---

## Accounts

| Login | How to sign in | Role / workspace |
|---|---|---|
| Dev #90 (Junkluggers) | On the dev login screen, click the **🔧 Dev sign-in · Vonigo #90** button | Owner, franchise 90 (super-admin surfaces on) |

The Pipeline card is gated to **dev env / super-admin / tester** franchises. On dev the 🔧 Dev sign-in satisfies the gate, so the card shows.

## Conventions (read once)

- **Fresh window:** open a new **incognito/private** window for a clean session.
- **Version check:** press **F12** → Console tab → confirm the green banner reads **CrewLogic v5.121.0**. If it still says v5.120.x, the dev preview hasn't finished building (wait ~1–2 min) or hard-refresh (Cmd-Shift-R).
- **"Read-back"** means: after an action, reload the screen (or toggle the view) and confirm the change stuck.
- Data is live #90 Vonigo data pulled into the dev DB. Exact names/counts will differ from this doc — assert **behavior**, not specific customers.

---

## Test 1 — Card + first paint (LOW)

**Precondition:** signed in as Dev #90.
**Why:** the feature is reachable and loads.

1. From Home, confirm a **🗂️ Follow-up Pipeline** card is present. → **Expected:** card visible with desc "Leads, unconverted estimates & cancellations to work".
2. Tap it. → **Expected:** header title "Follow-up Pipeline"; a list of item rows appears (may take a second). Each row shows a name, a colored **type badge** (Lead / Unconverted / Cancelled / Urgent CB / Case), and a footer with a next-touch pill + Stage + Sequence dropdowns.
3. Confirm the sub-line reads "**N open** across leads, unconverted estimates, cancellations, urgent callbacks & cases".

Pass / Fail: ___  Notes: ___

## Test 2 — Type filter + view toggle (LOW/MED)

1. In the chip row, note the count on each type chip (🌱 Leads, 📝 Unconverted, ✖️ Cancellations, 📞 Urgent callbacks, 🛟 Cases).
2. Tap the **Cancellations** chip to turn it **off**. → **Expected:** cancellation rows disappear immediately; other rows stay; **the page does not jump to the top or reload** (instant, client-side).
3. Tap it back **on**. → **Expected:** cancellation rows return.
4. Tap the **All** button (top-right toggle). → **Expected:** the list reloads and may grow (won/lost/dismissed items now included). Tap **Needs attention** → shrinks back to open items.
5. Type a partial customer name in the **Search** box. → **Expected:** list narrows as you type; the search box keeps focus (no caret jump).

Pass / Fail: ___  Notes: ___

## Test 3 — Contact chips (LOW)

1. Find a row that has a phone/email. → **Expected:** 📞 Call, 💬 Text (if phone) and ✉️ Email (if email) chips render.
2. (Optional, phone/desktop) Click **📞 Call** → **Expected:** the OS offers to place a call / open the dialer (`tel:` link). ✉️ Email opens a mail compose. No error.

Pass / Fail: ___  Notes: ___

## Test 4 — Stage change + read-back (MED)

1. On any open row, change the **Stage** dropdown from **New** to **Contacted**. → **Expected:** brief pause, list reloads, that row now shows **Contacted**.
2. Change another row's stage to **Won**. → **Expected:** in "Needs attention" view the row **leaves the list** (won is closed); its next-touch reminders are cleared. Switch to **All** → the row is still there, marked **Won**.
3. **Read-back:** leave the Pipeline screen (Back to Home), re-open it. → **Expected:** the stage changes persisted.

Pass / Fail: ___  Notes: ___

## Test 5 — Assign a sequence + next-touch appears (MED)

1. On an open **Lead** row whose Sequence dropdown says "No sequence", pick **Standard Lead**. → **Expected:** brief pause, list reloads; the row's **next-touch pill** now shows a scheduled touch (e.g. "📞 Tomorrow" or a date).
2. **Read-back:** the Sequence dropdown on that row now shows **Standard Lead**.
3. Change the same row's Sequence to **No sequence**. → **Expected:** next-touch pill returns to "No follow-up".

Pass / Fail: ___  Notes: ___

## Test 6 — Work a touch: Done + Snooze (MED)

1. On a row that has a next-touch pill, click **✓ Done**. → **Expected:** list reloads; the pill advances to the **next** scheduled touch (or "No follow-up" if that was the last step).
2. On a row with a next-touch, click **⏰ Snooze** → **+3 days**. → **Expected:** the modal closes, list reloads, and the next-touch pill moves out ~3 days.

Pass / Fail: ___  Notes: ___

## Test 7 — Note (MED, mid-interaction guard)

1. **Scroll ~10–15 rows down.** On a row there, click the **📝** button. → **Expected:** a Note modal opens over the list.
2. Type "Called, left VM" → **Save note**. → **Expected:** modal closes; the row shows a "📝 Called, left VM" line; **the list stays scrolled roughly where it was** (does not throw you to the top).
3. **Read-back:** re-open the 📝 modal on that row → the note text is there.

Pass / Fail: ___  Notes: ___

## Test 8 — Template Compose (MED)

1. Assign a row to a sequence whose step includes an email/text template (e.g. **Estimate Drip** on an unconverted estimate — its day-3 step is an email).
2. If the row's next touch is email/text, a **📄 Template** chip appears — click it. → **Expected:** a modal shows a subject/message with the customer's first name merged in (no literal `{{first_name}}`). **Copy** copies it; **Open email/text** opens a prefilled compose.

Pass / Fail: ___  Notes: ___

## Test 9 — Sequence builder: create / edit / delete (MED)

1. Click **⚙️ Sequences** (top-right). → **Expected:** modal lists the 5 starter sequences (Standard Lead, Reschedule Follow-up, Estimate Drip, Urgent Callback, Case Callback), each with a step count.
2. Click **+ New sequence**. Name it **Realtor outreach**. Set **Auto-default for type** = **— none —**. Add steps: Step 1 = after **0 day**, **call**; add Step 2 = after **2 days**, **email**, Subject "Quick question, {{first_name}}", Message "Hi {{first_name}} — thanks for reaching out to {{franchise}}…". Click **Save sequence**. → **Expected:** back to the sequence list, "Realtor outreach · 2 steps" now present.
3. On the Pipeline list, a row's **Sequence** dropdown now includes **Realtor outreach** — assign a lead to it → **Expected:** the row schedules a call today + an email in 2 days.
4. Re-open **⚙️ Sequences** → **Edit** Realtor outreach → change Step 2 delay to **3 days** → Save. → **Expected:** saved (no error).
5. **Delete** Realtor outreach (confirm the prompt). → **Expected:** it disappears from the list; any item that was on it is detached (its Sequence dropdown shows "No sequence") but keeps its already-scheduled touches.

Pass / Fail: ___  Notes: ___

## Test 10 — Sync now (MED)

1. Click **↻ Sync now**. → **Expected:** button shows "Syncing…", then the list refreshes. No error alert. (Re-syncing preserves your stage/sequence/notes changes — spot-check a row you edited in Test 4/5 still shows your edit.)

Pass / Fail: ___  Notes: ___

## Test 11 — Dismiss (LOW)

1. On a low-value row, click **✕** → confirm. → **Expected:** row leaves "Needs attention"; findable again under **All** as **Dismissed**.

Pass / Fail: ___  Notes: ___

---

### If anything fails
Note the row/type, what you did, what you expected, and what happened (plus any Console error from F12). Server actions live in `crewlogic-pipeline`; client in `index.html` (`renderPipeline` / `pl*`).
