# QA Test Plan — v5.95.0 (dev): Truck→route assignment + day-start feasibility + arrival statement (FW-59)

**Where:** https://dev.crewlogic.pages.dev → **🔧 Dev sign-in · #90** → open **Dispatch**.
**Confirm version:** bottom banner reads **v5.95.0** (hard-refresh Cmd+Shift+R if not).
**Best test day:** set the **SOURCE date to 7/28** (has 2 routes with jobs). Today (7/27) also works (Sferrazza on MA1REG).

## Tests

| # | Do this | Expected |
|---|---------|----------|
| 1 | Look at both boards (SOURCE + DESTINATION) | Each has a **TRUCK** column between the route code and the first time slot |
| 2 | Tap a route's truck cell → check **Truck 1** → **Apply** | Cell shows **●T1** |
| 3 | On another route, check **Truck 1 + Truck 2** → **Apply** | Cell shows **●T1 ●T2** (piggyback); both routes show a **`*`** next to Truck 1 (on 2 routes) |
| 4 | Look at the **route-code cells** (MA1REG, etc.) | Background is tinted **green** (makes its windows) or **red** (runs late) |
| 5 | **Click a route code** | An **explain modal** opens: verdict, leave-yard time, each job's window vs. predicted arrival, and the method note |
| 6 | Change **Finish speed** (top-right of the board) toward 140% | Route cells flip toward **red** as routes get tight; the modal reflects it |
| 7 | **Click a job** on the board (e.g. Sferrazza / MA1REG) | Popup **leads with**: "We anticipate **Truck …** at **TIME** for **NAME** in **TOWN**. This is within / N-min-past the window." (green box on time, red if late) |
| 8 | In that job popup | The **Job # 🔗** links to Vonigo, and the **Phone** row is a tappable number |
| 9 | Reload the page, reopen Dispatch | Assigned trucks + green/red + statement all **persist** |
| 10 | Scroll the board, then set a truck on a visible route | Board **does not jump/blank** — only that cell updates |

## Not failures (dev quirks)
- Live truck **dots** may be gray on dev (no live GPS there).
- A route with **no jobs** shows no green/red and no statement.
- The prediction is a **day-start guesstimate** (labeled as such) — live GPS ETAs are a later phase.
