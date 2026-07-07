# Geofence Setup Guide (for CrewLogic Dispatch)

_Draft — franchisee-facing. Review before we surface it (in-app help / PDF / web page)._

## Why this matters

CrewLogic reads your telematics **geofences** (Motive / Linxup) to power the dispatch map and Live Alerts:

- **which truck is at which site** (a 🗑️ / ♻️ / 🎁 badge appears on the truck icon),
- **how long it's been there** (a live "on-site 42m" dwell timer), and
- **a red flag when it's been too long** (past your wait time for that kind of site).

For that to work, each geofence needs the right **Category**. CrewLogic classifies off the **category — not the geofence name** — so you can name your geofences however you like; just set the category correctly.

---

## Motive

### Set a geofence's category
**Fleet → Geofences → open the geofence → Category → pick the correct one → Save.**

### Categories CrewLogic recognizes

| Motive Category | Truck badge | Wait-time it uses (Settings) |
|---|---|---|
| **Transfer Station** (also Disposal / Landfill) | 🗑️ | Disposal |
| **Recycling** | ♻️ | Recycling |
| **Donations** | 🎁 | Donation |
| **Job Site** | _(automatic — CrewLogic creates job geofences from your schedule)_ | the job's scheduled duration |
| Truck Stop / Rest Area, Restricted Location, Receiver / Consignee, **Uncategorized** | _(no badge — on purpose)_ | — |

### Key points
- **Category drives it, not the name.** e.g. a geofence named "Lost Brothers Pallets" set to category **Recycling** shows ♻️ — correctly.
- **Anything left "Uncategorized" gets no badge.** Categorize every transfer/disposal, recycling, and donation site.
- Make sure the geofence is **Active**.

---

## Linxup
Linxup uses **Groups** instead of Categories. **(Support coming — CrewLogic will read your Linxup groups.)** When it lands, name your group `Transfer Station`, `Recycling`, or `Donations` to match.

---

## Wait-time thresholds
The red "too long" flag fires when a truck has been at a site longer than **your wait time for that type**. Set these in:

**CrewLogic → Settings → ⏱ Wait Times (minutes per load):** Disposal · Recycling · Donation.

---

## Quick checklist
- [ ] Every transfer/disposal, recycling, and donation site you use has a geofence.
- [ ] Each is set to the **correct Category** (not "Uncategorized").
- [ ] Each geofence is **Active**.
- [ ] **Wait Times** are set in CrewLogic Settings.
