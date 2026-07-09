# Geofence Setup Guide (for CrewLogic Dispatch)

_Draft — franchisee-facing. Review before we surface it (in-app help / PDF / web page)._

## Why this matters

CrewLogic reads your telematics **geofences** (Motive / Linxup) to power the dispatch map and Live Alerts:

- **which truck is at which site** (a 🗑️ / ♻️ / 🎁 badge appears on the truck icon),
- **how long it's been there** (a live "on-site 42m" dwell timer), and
- **a red flag when it's been too long** (past your wait time for that kind of site).

For that to work, each geofence needs the right label — a **Category** in Motive, a **Group** in Linxup. CrewLogic classifies off that label — **not the geofence name** — so name your geofences however you like; just set the Category/Group correctly. (Both use the same words: Transfer Station / Recycling / Donations.)

---

## Motive

### Set a geofence's category
**Fleet → Geofences → open the geofence → Category → pick the correct one → Save.**

### Categories CrewLogic recognizes

| Motive Category | Truck badge | Wait-time it uses (Settings) |
|---|---|---|
| **Transfer** or **Disposal** _(either works — also Landfill / Dump)_ | 🗑️ | Disposal |
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
Linxup's equivalent of Motive's Category is a **Group** — CrewLogic reads it the same way (from the `fenceGroup` on each pushed event). Put each geofence in a Group named `Transfer Station`, `Recycling`, or `Donations`.

**Webhook setup** (Linxup pushes events to CrewLogic):
1. In CrewLogic → **Settings → Trucks**, copy the **webhook URL** shown and click **Generate token**.
2. In Linxup's **Push API** config: paste the URL into **Geofence Event URL**, and paste CrewLogic's **generated token** into **Bearer Token**.
3. **Not** your Linxup API key — that token goes in CrewLogic's separate "Linxup REST token" box (for pulling live truck positions). CrewLogic generates the webhook token; you paste it *into* Linxup.

---

## Wait-time thresholds
The red "too long" flag fires when a truck has been at a site longer than **your wait time for that type**. Set these in:

**CrewLogic → Settings → ⏱ Wait Times (minutes per load):** Disposal · Recycling · Donation.

---

## Quick checklist
- [ ] Every transfer/disposal, recycling, and donation site you use has a geofence.
- [ ] Each is set to the **correct Category** (Motive) or **Group** (Linxup) — not left blank/Uncategorized.
- [ ] Each geofence is **Active**.
- [ ] **Wait Times** are set in CrewLogic Settings.
