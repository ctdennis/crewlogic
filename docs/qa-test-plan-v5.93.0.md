# QA Test Plan — v5.93.0 (dev): Truck-assignment column

**What shipped:** a **TRUCK** column on the Manage Jobs schedule board — assign one or more trucks to each route per day.
**Where:** https://dev.crewlogic.pages.dev  (dev build, ~1–2 min after push)
**Risk:** MEDIUM (writes data + the board re-renders).

## Setup (once)
1. Open **https://dev.crewlogic.pages.dev** in a fresh window.
2. Click the **🔧 Dev sign-in · Vonigo #90** button.
3. Open **Manage Jobs** (the schedule board).
4. Press **F12 → Console** and confirm it says **v5.93.0**.

## Tests

| # | Do this | Expected | Pass/Fail |
|---|---------|----------|-----------|
| 1 | Look at the board | A **TRUCK** column sits between the route code and the first time slot. Routes with no truck show **"+ truck"**. | |
| 2 | Tap a route's truck cell | A popup opens listing **Truck 1 / 2 / 3** with checkboxes. | |
| 3 | Check **Truck 1**, tap **Apply** | Cell shows **"● Truck 1"** (the dot may be gray on dev — fine). | |
| 4 | On a **different** route, check **Truck 1 + Truck 2**, tap **Apply** | Cell shows **both** trucks. | |
| 5 | Look at Truck 1 on both routes | A small **`*`** appears next to Truck 1 (it's on 2 routes). Hover → "Also on another route today." | |
| 6 | **Reload the page**, reopen Manage Jobs | The trucks and the `*` are **still there**. | |
| 7 | Scroll the board, then set a truck on a visible route | The board **does not jump or blank** — only that one cell changes. | |
| 8 | Open a route's popup, uncheck everything, **Apply** | Cell goes back to **"+ truck"**. | |
| 9 | Switch the **date chips** at the top | The TRUCK column reloads for that day (assignments are per date). | |

## Notes
- Close the popup by clicking outside it or **Cancel**.
- Live dots need live GPS; on dev they may all be gray — not a failure.
- This slice is **assignment only** — the arrival-time prediction (ETA chips + the "we anticipate…" statement) is the next slice.
