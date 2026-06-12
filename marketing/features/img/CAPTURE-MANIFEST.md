# Marketing feature-page screenshot manifest

Drop the PNGs listed below into this folder (`marketing/features/img/`) using the **exact**
filename. Pages reference them via `<img src="img/<name>.png">` and currently render a labeled
dashed-box placeholder until the file exists (graceful `onerror` fallback — no broken images).

Tracking: this is the screenshot half of the "Marketing feature pages" backlog row in
`.HUB/Hub.md`. Mark each row Done as the file lands.

## ⚠️ PII rule (blocking)

These pages are **public**. Screenshots must NOT show real customer names, addresses, phone
numbers, or emails. Capture from a **synthetic/demo franchise** (fake customers + estimates),
or scrub/blur any real data before saving. Prod (#90) and a prod-refreshed dev #90 both carry
real Junkluggers customer data — do not publish those raw.

## The 15 files (16 slots; `proposal-send.png` is reused)

| Status | File | Page | What to show (alt text) |
|---|---|---|---|
| [ ] | `ai-analysis.png` | ai-estimating | AI analysis view with volume breakdown |
| [ ] | `itemized-estimate.png` | ai-estimating | Itemized estimate with line items and prices |
| [ ] | `proposal-send.png` | ai-estimating **+** proposals | Proposal send screen / email preview |
| [ ] | `cost-breakdown.png` | cost-margin | Cost breakdown — labor / disposal / fuel split |
| [ ] | `disposal-line.png` | cost-margin | Disposal cost line-item detail |
| [ ] | `margin-indicator.png` | cost-margin | Margin indicator on the estimate screen |
| [x] | `price-tiers.png` | price-book | Volume pricing tiers (per-truckload) |
| [x] | `surcharges.png` | price-book | Per-item surcharges |
| [ ] | `proposal-pdf.png` | proposals | Sample proposal PDF render |
| [ ] | `leaderboard.png` | yard-signs | Crew leaderboard view |
| [ ] | `sign-map.png` | yard-signs | Sign map view |
| [ ] | `crm-sync-settings.png` | crm-integration | CRM sync settings / pricing source toggle |
| [ ] | `crm-quote-record.png` | crm-integration | CRM quote record populated from CrewLogicAI |

## Tips
- Mobile-width capture (the app is mobile-first / PWA) reads best in the page's `.shot` frame.
- Keep them visually consistent: same device frame / zoom / theme across all 15.
- PNG, reasonably compressed; the `.shot` frame scales them responsively.
