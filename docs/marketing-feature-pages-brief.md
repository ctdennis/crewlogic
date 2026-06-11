# CrewLogicAI — Feature Detail Pages Brief
**For Claude Code | Marketing Site Expansion**

---

## Design System Reference

All pages must inherit from `index.html`. Do not introduce new design tokens.

```css
/* Existing tokens — use these exactly */
--bg: #0b131d
--bg-2: #0e1825
--card: #152230
--tile: #1e2f40
--ink: #eef4fa
--body: #9fb1c2
--muted: #6e8194
--green: #00E785
--green-ink: #04261a
--green-soft: rgba(0,231,133,0.12)
--border: #22354a
--radius: 16px
--mono: 'Space Mono'
```

**Fonts:** DM Sans (body/headings) + Space Mono (accents/numbers)  
**Existing components to reuse:** `.feat`, `.how`, `.eyebrow`, `.btn-green`, `.btn-outline`, `.head`, `.trust`, `.sec-2`, `.wrap`

---

## Shared Page Template

Every feature detail page uses this section structure:

```
1. HERO          — eyebrow + H1 + sub + CTA + how-it-works panel (right col)
2. FAB GRID      — 3-column Feature / Advantage / Benefit cards
3. DETAIL STRIP  — alternating left/right content + [screenshot placeholder]
4. PROOF BAND    — 3 stat/trust tiles (sec-2 background)
5. RELATED       — 3 linked cards to other feature pages
6. TRIAL CTA     — reuse signup section from index.html
```

**Navigation:** Add a `Features` dropdown to the existing header nav linking to each detail page.

**File naming:**
- `/features/ai-estimating.html`
- `/features/cost-margin.html`
- `/features/price-book.html`
- `/features/job-planning.html`
- `/features/proposals.html`
- `/features/yard-signs.html`
- `/features/crm-integration.html`

---

## Page 1 — AI Estimating
**File:** `/features/ai-estimating.html`

### Hero
```
EYEBROW:   AI Estimating
H1:        The job is priced before you leave the driveway.
SUB:       Snap photos, talk the job through — the AI reads the room,
           sizes the truckload volume, and hands you an itemized,
           priced estimate in minutes. No tape measure. No guesswork.
           No leaving money on the table.
CTA-1:     Start Free Trial  [btn-green → #trial]
CTA-2:     See How It Works  [btn-outline → #how]
REASSURE:  Free trial for owners & operators. No credit card required.
```

### How-It-Works Panel (right column, reuse .how component)
```
Step 1 — Capture
  Snap photos of every room or area. Add a voice note if you want
  to call out anything specific — oversized items, hazmat, stairs.

Step 2 — AI Analysis
  The AI reads your photos and voice, gauges cubic volume
  per area, maps items to your price book, and builds an
  itemized estimate with quantities and prices.

Step 3 — Review & Send
  You review, adjust if needed, and send a branded proposal
  to the customer — all before you've backed out of the driveway.
```

### FAB Grid

| | Feature | Advantage | Benefit |
|---|---|---|---|
| 🤖 | **AI volume analysis** from photos and voice notes | Measures cubic footage without a tape measure or manual count | You stop guessing and start pricing accurately — fewer underbids, more margin |
| 📋 | **Itemized line-item output** mapped to your price book | Every item is accounted for and priced consistently | Nothing gets missed on the truck, nothing gets missed on the invoice |
| 🔁 | **Editable before sending** — full owner override | You stay in control; AI is a starting point, not a black box | Confidence to quote on the spot without second-guessing yourself |
| ⚡ | **Estimate in minutes**, not hours | Fast enough to send before you leave the property | Customers get a number while they're still in the room — close rate goes up |
| 🎙️ | **Voice note input** in addition to photos | Capture context the camera can't see — stairs, weight, hazmat | More accurate estimates on complex jobs without extra steps |
| 📸 | **Photo-backed proposals** sent to the customer | Room photos appear in the customer-facing PDF | Professionalism that sets you apart from a verbal quote and a handshake |

### Detail Strips

**Strip 1 — Volume Intelligence**
```
LABEL:    How the AI thinks
HEADING:  It doesn't count items. It reads the room.
BODY:     Most estimating tools ask you to tap checkboxes. CrewLogicAI
          looks at your photos the way an experienced crew lead does —
          it gauges the density, the footprint, and the awkward stuff
          in the corners. The result is a truckload fraction that
          reflects reality, not a checklist.
[Screenshot placeholder: AI analysis view with volume breakdown]
```

**Strip 2 — Price Book Integration**
```
LABEL:    Tied to your prices
HEADING:  Every item maps to what you actually charge.
BODY:     The AI output feeds directly into your price book — your
          rates, your ZIP-code adjustments, your surcharges. Nothing
          is priced at a generic national average. The estimate
          reflects your market.
[Screenshot placeholder: Itemized estimate with line items and prices]
```

**Strip 3 — Speed to Send**
```
LABEL:    Close on the spot
HEADING:  Send the proposal before you leave the property.
BODY:     The gap between the walkthrough and the quote is where jobs
          get lost. A competitor calls while you're still driving home.
          CrewLogicAI closes that gap — review, adjust, send, done.
          Customers get a professional PDF in their inbox while
          you're still standing in their driveway.
[Screenshot placeholder: Proposal send screen / email preview]
```

### Proof Band (3 tiles, .sec-2 style)
```
Tile 1: 🎯  "Priced on the first visit"
             Stop calling back with revised numbers. One visit, one quote.

Tile 2: 💰  "Pays for itself on the first job"
             One avoided underbid typically covers months of subscription.

Tile 3: ⏱️  "Minutes, not hours"
             Average estimate time drops from 40+ minutes to under 5.
```

### Related Features
- Cost & Margin — *See your profit on every estimate*
- Proposals & PDFs — *Send a customer-ready document instantly*
- Pricing & Price Book — *The rates that power every estimate*

---

## Page 2 — Cost & Margin
**File:** `/features/cost-margin.html`

### Hero
```
EYEBROW:   Cost & Margin
H1:        Know your profit on every job before you say yes.
SUB:       Labor, disposal, and fuel roll into a live margin
           calculation on every estimate. No spreadsheet. No
           end-of-month surprises. Just a clear number that tells
           you whether the job is worth taking.
CTA-1:     Start Free Trial  [btn-green]
CTA-2:     Explore the Platform  [btn-outline → index.html#features]
```

### FAB Grid

| | Feature | Advantage | Benefit |
|---|---|---|---|
| 💵 | **Live margin on every estimate** — labor + disposal + fuel | All three cost drivers calculated automatically | You know your net before you commit to a price — no more gut-feel bids |
| 🗑️ | **Disposal cost engine** — tonnage and facility rates | Factors in actual transfer station rates per job | Heavy loads get priced right; you don't eat the disposal bill |
| 👷 | **Labor cost model** — crew size × time × rate | Calculates crew cost from your configured hourly rates | Every quote reflects what the job actually costs to run |
| ⛽ | **Fuel calculation** — distance and truck type | Accounts for drive time and fuel per job | No more absorbing fuel as overhead; it's in every price |
| 📊 | **Margin % displayed on estimate screen** | Instant visual on whether you're above your target | Owners and crew leads make better decisions at the point of quote |
| 🎛️ | **Configurable cost targets per franchise/location** | Each territory sets its own labor and overhead rates | Franchise operators price for their market, not a national average |

### Detail Strips

**Strip 1 — The Three Cost Drivers**
```
LABEL:    What goes into the number
HEADING:  Labor. Disposal. Fuel. All three, every time.
BODY:     Most operators have a feel for disposal costs. Fewer
          account for the true labor hours on a messy job, and
          almost nobody builds fuel in line-by-line. CrewLogicAI
          rolls all three into a single margin number — so the
          estimate screen tells you the whole story, not just
          the top line.
[Screenshot placeholder: Cost breakdown panel showing L/D/F split]
```

**Strip 2 — Disposal Intelligence**
```
LABEL:    Your real disposal cost
HEADING:  Tonnage estimates baked into every job.
BODY:     Disposal is the wildcard that kills margins on large jobs.
          CrewLogicAI estimates weight from volume and maps it to
          your configured facility rates — so a 1.5-truck load near
          a $125/ton facility gets priced correctly, not averaged
          against a job from two states away.
[Screenshot placeholder: Disposal cost line item detail]
```

**Strip 3 — Margin Target**
```
LABEL:    Your floor, your call
HEADING:  Set a target margin. See instantly if you're above it.
BODY:     Configure your target gross margin in settings. Every
          estimate shows a green/yellow/red indicator against
          that target. Owners know at a glance if a quote needs
          adjustment — before it goes to the customer.
[Screenshot placeholder: Margin indicator on estimate screen]
```

### Proof Band
```
Tile 1: 📉  "End the margin surprises"
             See profit before you commit, not after the job closes.

Tile 2: 🗑️  "Disposal is the hidden killer"
             Jobs priced without real disposal math bleed margin quietly.

Tile 3: 👀  "One number your whole team trusts"
             Labor, disposal, and fuel in one line — no reconciliation needed.
```

### Related Features
- AI Estimating — *The engine that feeds the cost model*
- Pricing & Price Book — *The rates that power the margin math*
- Job Planning & Routes — *Plan loads to control disposal runs*

---

## Page 3 — Pricing & Price Book
**File:** `/features/price-book.html`

### Hero
```
EYEBROW:   Pricing & Price Book
H1:        Your rates. Your ZIP codes. Zero manual math.
SUB:       ZIP-mapped price lists ensure every estimate reflects
           your market — not a national average. Native pricing
           or synced with your CRM. Coverage gaps don't exist.
CTA-1:     Start Free Trial  [btn-green]
CTA-2:     Explore the Platform  [btn-outline]
```

### FAB Grid

| | Feature | Advantage | Benefit |
|---|---|---|---|
| 🗺️ | **ZIP-code-mapped pricing** | Different rates for different territories automatically applied | A job in Providence prices differently than one in Fall River — without manual switching |
| 📖 | **Native price book** — built and managed in-app | No dependency on a third-party CRM for basic pricing | Operators without a CRM get full pricing power out of the box |
| 🔗 | **CRM sync** — pull live rates from your existing system | Prices stay in one source of truth | No double-maintenance; update rates in your CRM, they flow to estimates automatically |
| 🪣 | **Catch-all coverage** — no ZIP gaps | Every address gets a price, even outside your primary territory | Estimates never fail because a ZIP code wasn't in the list |
| 💱 | **Per-item and per-load pricing** | Mix unit prices (mattress: $X) with load fractions | Price books match how junk removal is actually sold |
| 🔒 | **Role-based price book access** | Owners edit; estimators use | Crews quote from approved rates; owners control the margin |

### Detail Strips

**Strip 1 — ZIP Mapping**
```
LABEL:    Priced for your market
HEADING:  The same mattress costs more to haul in Boston than in Brockton.
BODY:     Your labor costs, disposal rates, and competitive pricing
          all vary by ZIP code. CrewLogicAI maps your rates to
          territories so estimates reflect reality — automatically,
          without the estimator needing to know which zone they're in.
[Screenshot placeholder: ZIP territory map or price book configuration]
```

**Strip 2 — CRM Sync**
```
LABEL:    One source of truth
HEADING:  Update rates once. Everywhere stays current.
BODY:     If your CRM is already your system of record for pricing,
          CrewLogicAI pulls from it live. No exports, no manual
          syncs, no version drift between what's in the CRM and
          what's on the estimate screen.
[Screenshot placeholder: CRM sync settings screen]
```

### Proof Band
```
Tile 1: 🗺️  "Territory-aware by default"
             Every estimate priced for where the job actually is.

Tile 2: 🔄  "CRM sync or standalone"
             Works with your existing system or entirely on its own.

Tile 3: 🪣  "No ZIP-code gaps"
             Catch-all coverage means no estimate ever fails silently.
```

### Related Features
- AI Estimating — *Pulls from your price book on every job*
- Cost & Margin — *Rates feed the margin calculation*
- CRM Integration — *Keep pricing in sync across systems*

---

## Page 4 — Job Planning & Routes
**File:** `/features/job-planning.html`

### Hero
```
EYEBROW:   Job Planning & Routes
H1:        Every stop briefed. Every load accounted for.
SUB:       Per-stop route briefs give your crew the truckload
           volume, the disposal math, and the job details before
           they arrive. Less calling back to the office. Fewer
           surprises at the curb.
CTA-1:     Start Free Trial  [btn-green]
CTA-2:     Explore the Platform  [btn-outline]
```

### FAB Grid

| | Feature | Advantage | Benefit |
|---|---|---|---|
| 🗺️ | **Per-stop route briefs** with volume and load math | Crew knows the expected truckload fraction before arrival | No on-site guessing about whether you'll need a second truck |
| ⚖️ | **Truckload math per job** — fractions and totals | Cumulative load tracked across the day's stops | Optimize when to dump and whether to combine loads |
| 🗑️ | **Disposal run planning** — facility options and drive time | Compare dump-now vs. combine-loads scenarios | Save disposal trips, reduce drive time, protect margin |
| 📋 | **Job brief for the crew** — items, notes, access details | All job context in one view on the crew's phone | Fewer calls to dispatch; crew arrives prepared |
| 📍 | **Stop sequencing** — optimized order | Minimizes total drive time across the day | More jobs per day, lower fuel cost, less crew fatigue |
| 🔄 | **Real-time updates** — owner can push changes to crew | Day-of changes flow to the field instantly | No stale printouts; crew always has current information |

### Detail Strips

**Strip 1 — The Route Brief**
```
LABEL:    What the crew sees
HEADING:  Every stop. Volume, items, access, notes.
BODY:     Before the crew rolls, they have a brief for each stop:
          expected volume, notable items, customer notes, and access
          details. The same information the estimator captured is in
          their hands when they pull up to the curb.
[Screenshot placeholder: Route brief / stop detail screen]
```

**Strip 2 — Load Math**
```
LABEL:    Know before you go
HEADING:  Will this load fit? Plan it before you leave the yard.
BODY:     The day's jobs have cumulative load math — fraction by
          fraction, stop by stop. You see before the day starts
          whether you're running one truck or two, and where the
          optimal dump point is. No mid-day scramble.
[Screenshot placeholder: Day view with cumulative truck load fractions]
```

### Proof Band
```
Tile 1: 🚛  "Right-sized trucks every day"
             Know before dispatch whether you need one truck or two.

Tile 2: 📞  "Fewer calls back to the office"
             Crew has everything they need before they arrive.

Tile 3: 🗑️  "Fewer wasted disposal trips"
             Plan dumps around load math, not habit.
```

### Related Features
- AI Estimating — *The volume data that powers the route brief*
- Cost & Margin — *Disposal planning protects your margin*
- Proposals & PDFs — *The customer-facing side of every job*

---

## Page 5 — Proposals & PDFs
**File:** `/features/proposals.html`

### Hero
```
EYEBROW:   Proposals & PDFs
H1:        A customer-ready proposal, straight from the estimate.
SUB:       Branded with your logo and colors. Room-by-room
           descriptions. Photos from the walkthrough. The kind
           of document that wins jobs over a competitor's verbal quote.
CTA-1:     Start Free Trial  [btn-green]
CTA-2:     Explore the Platform  [btn-outline]
```

### FAB Grid

| | Feature | Advantage | Benefit |
|---|---|---|---|
| 🎨 | **Branded output** — your logo, your colors | Every PDF looks like it came from your company, not a generic app | Professional appearance builds trust; trust wins jobs |
| 📸 | **Photos embedded in the proposal** | Customer sees the same rooms the estimator walked through | Reduces disputes, sets expectations, and demonstrates thoroughness |
| 📋 | **Room-by-room itemization** | Customers see exactly what's included and where | No ambiguity about what's in scope; fewer "but I thought you were taking..." calls |
| ⚡ | **Generated from the estimate instantly** — no rekeying | One tap produces the PDF from the estimate data | Send while you're still on site; no office step required |
| 📧 | **Send via email from the app** | Customer gets a PDF in their inbox immediately | Speed of response is a competitive advantage |
| 📝 | **Includes Terms & Conditions** | Legal coverage baked into every customer document | Protects the business without a separate signature step |

### Detail Strips

**Strip 1 — What It Looks Like**
```
LABEL:    The document customers see
HEADING:  More than a price. A professional case for hiring you.
BODY:     The proposal includes your logo, the job address, a
          room-by-room breakdown with photos, line-item pricing,
          total, and your terms. It looks like something a larger
          company would send — because that's the point.
[Screenshot placeholder: Sample proposal PDF render]
```

**Strip 2 — Speed to Send**
```
LABEL:    While you're still there
HEADING:  Send before you back out of the driveway.
BODY:     The proposal generates from your estimate in one tap.
          Email it to the customer from the app. They have a
          document in their hands while you're still in their
          neighborhood — and your competitor is still writing
          numbers on a clipboard.
[Screenshot placeholder: Send proposal screen]
```

### Proof Band
```
Tile 1: 📄  "Proposal in one tap"
             Generated from the estimate. No rekeying, no delays.

Tile 2: 🏆  "Win on professionalism"
             A branded PDF beats a verbal quote every time.

Tile 3: 📸  "Photos in the proposal"
             The customer sees exactly what you walked through.
```

### Related Features
- AI Estimating — *The estimate that generates the proposal*
- Pricing & Price Book — *The rates behind the line items*
- CRM Integration — *Push the proposal into your CRM automatically*

---

## Page 6 — Yard Signs
**File:** `/features/yard-signs.html`

### Hero
```
EYEBROW:   Yard Signs
H1:        Track every sign. Reward the crew that places them.
SUB:       Log yard sign placements in the field, see them on a
           map, and run a crew leaderboard that makes sign drops
           a competition worth winning.
CTA-1:     Start Free Trial  [btn-green]
CTA-2:     Explore the Platform  [btn-outline]
```

### FAB Grid

| | Feature | Advantage | Benefit |
|---|---|---|---|
| 📍 | **Field placement logging** — tap to record a sign drop | Accurate location data for every sign, logged as it happens | You know where signs are, without a spreadsheet or crew check-ins |
| 🗺️ | **Map view of all active signs** | Visual coverage of your sign territory | Spot gaps in coverage and high-performing neighborhoods at a glance |
| 🏆 | **Crew leaderboard** — placement counts per team member | Turns sign drops into a friendly competition | Crew places more signs because the scoreboard is visible |
| 🔔 | **Pickup reminders** — age-based alerts | Signs don't get forgotten in the field for months | You recover your inventory and stay in good standing with ordinances |
| 📊 | **Placement history and reporting** | Track sign activity over time by crew member | Know who's contributing to neighborhood marketing and who isn't |
| 🎁 | **Rewards integration** — tie placements to crew incentives | Formal reward mechanism beyond the leaderboard | Drives consistent behavior, not just one-week spikes |

### Detail Strips

**Strip 1 — The Leaderboard**
```
LABEL:    Make it a game
HEADING:  The crew that sees a scoreboard places more signs.
BODY:     When sign placements are invisible, they're optional.
          When there's a leaderboard, they become a competition.
          CrewLogicAI surfaces placement counts by crew member
          in real time — so the team knows exactly where they
          stand and what it takes to move up.
[Screenshot placeholder: Crew leaderboard view]
```

**Strip 2 — Map View**
```
LABEL:    Coverage at a glance
HEADING:  See where your signs are working.
BODY:     Every logged placement appears on the map. Owners can
          see concentration by neighborhood, identify areas with
          no coverage, and cross-reference sign locations with
          job density to understand where signs actually drive leads.
[Screenshot placeholder: Sign map view]
```

### Proof Band
```
Tile 1: 📍  "Every sign logged as it drops"
             No manual tracking, no lost signs, no guessing.

Tile 2: 🏆  "Gamification drives behavior"
             Crews with a visible score place more signs — consistently.

Tile 3: 🗺️  "Map your coverage gaps"
             Know where you're visible and where you're not.
```

### Related Features
- Job Planning & Routes — *Sign drops can be part of the route*
- AI Estimating — *Know which neighborhoods are generating jobs*
- CRM Integration — *Tie sign activity to lead source tracking*

---

## Page 7 — CRM Integration
**File:** `/features/crm-integration.html`

### Hero
```
EYEBROW:   CRM Integration
H1:        Your CRM and your field app, finally talking to each other.
SUB:       Pull live pricing from your CRM into every estimate.
           Push completed quotes back automatically. No copy-paste.
           No version drift. One source of truth across both systems.
CTA-1:     Start Free Trial  [btn-green]
CTA-2:     Explore the Platform  [btn-outline]
```

### FAB Grid

| | Feature | Advantage | Benefit |
|---|---|---|---|
| 🔄 | **Live pricing pull from CRM** | Estimate screen always reflects current CRM rates | Price changes in your CRM flow to the field instantly — no manual sync |
| 📤 | **Quote push to CRM** | Completed estimates land in your CRM automatically | No rekeying quotes; your CRM history stays complete without extra steps |
| 🔗 | **Supported CRM integrations** (Vonigo and expanding) | Works with the CRM junk removal operators already use | No need to switch systems; CrewLogicAI works alongside what you have |
| 🔒 | **Secure API connection** | Credentials managed server-side; no plaintext keys in the app | Integration is safe to deploy across a franchise network |
| 📋 | **Job record sync** | Customer, address, and job details flow between systems | One entry, two systems updated — crew and office see the same record |
| ⚡ | **Real-time, not batch** | Data moves as it happens, not on a nightly schedule | The field and the office are never looking at different versions |

### Detail Strips

**Strip 1 — Pricing Sync**
```
LABEL:    Rates in sync
HEADING:  Your CRM is the source of truth. Keep it that way.
BODY:     If your pricing lives in your CRM, that's where it
          should stay. CrewLogicAI pulls rates live so your
          estimators are always quoting from current prices —
          not a snapshot that was exported three weeks ago.
[Screenshot placeholder: CRM sync settings / pricing source toggle]
```

**Strip 2 — Quote Pushback**
```
LABEL:    Close the loop
HEADING:  What gets estimated gets recorded.
BODY:     When an estimate is finalized, CrewLogicAI pushes the
          quote back to the CRM record. No manual entry. Your
          CRM pipeline stays current, your reporting is accurate,
          and your office team sees what the field quoted without
          asking.
[Screenshot placeholder: CRM quote record populated from CrewLogicAI]
```

### Proof Band
```
Tile 1: 🔄  "Always current pricing"
             Field estimates reflect today's CRM rates, not last month's export.

Tile 2: 📤  "Quotes flow back automatically"
             Your CRM pipeline stays accurate without manual entry.

Tile 3: 🔗  "Built for junk removal operators"
             Native Vonigo integration with more CRMs on the roadmap.
```

### Related Features
- Pricing & Price Book — *Native pricing for operators without a CRM*
- Proposals & PDFs — *The customer document that goes with the quote*
- AI Estimating — *The estimates that feed the integration*

---

## Global Navigation Update

Update `index.html` header to add a Features dropdown:

```html
<!-- Replace single Login link with nav that includes Features dropdown -->
<nav class="nav-links">
  <div class="dropdown">
    <button class="btn-ghost">Features ▾</button>
    <div class="dropdown-menu">
      <a href="/features/ai-estimating.html">🤖 AI Estimating</a>
      <a href="/features/cost-margin.html">💵 Cost & Margin</a>
      <a href="/features/price-book.html">🏷️ Pricing & Price Book</a>
      <a href="/features/job-planning.html">🗺️ Job Planning & Routes</a>
      <a href="/features/proposals.html">📄 Proposals & PDFs</a>
      <a href="/features/yard-signs.html">🪧 Yard Signs</a>
      <a href="/features/crm-integration.html">🔗 CRM Integration</a>
    </div>
  </div>
  <a href="https://app.crewlogicai.com" class="btn btn-ghost">Login</a>
</nav>
```

---

## Implementation Notes for Claude Code

1. **Reuse `.how` component** from index.html for the hero right-column on AI Estimating. Other pages can use a simpler stats/highlight panel in that slot.

2. **Screenshot placeholders** should render as `.feat`-styled cards with a dashed border, the `--tile` background, and a centered label like `[ Screenshot: AI analysis view ]`. These are swapped for real images later.

3. **FAB Grid** — render as a 3-column grid of `.feat` cards. Each card has: icon (`.ico`), bold Feature name, Advantage in `--body` color, Benefit in a small `--green` callout at the bottom.

4. **Alternating detail strips** — odd strips: copy left, screenshot right. Even strips: screenshot left, copy right. Stack on mobile.

5. **Related Features** — render as a 3-up row of `.feat` cards with a `→` link. These live just above the trial CTA section.

6. **Trial CTA section** — copy verbatim from `index.html` `#trial` section. Same form, same Supabase logic.

7. **SEO** — each page needs a unique `<title>` and `<meta name="description">`. Use the Hero H1 + SUB copy as the basis.

   Example for AI Estimating:
   ```html
   <title>AI Estimating — CrewLogicAI</title>
   <meta name="description" content="Photos and voice notes become a priced, itemized estimate in minutes. The AI sizes truckload volume so nothing gets missed and nothing gets under-priced.">
   ```

8. **Breadcrumb** — add a simple text breadcrumb below the header on all feature pages:
   ```
   Home  /  Features  /  AI Estimating
   ```

9. **Mobile** — all grids collapse to single column at 560px, matching `index.html` breakpoints.

10. **Tone** — match index.html: short sentences, plain language, owner/operator voice. Never "utilize." Avoid passive voice. Lead every section with the outcome, not the feature name.

---

## Build Decisions (owner-confirmed 2026-06-11)

These override/refine the brief above:

1. **Numeric claims → softened to qualitative.** Replace specific stats in proof bands with non-numeric framing to avoid unsubstantiated specifics. E.g. "40+ minutes to under 5" → "minutes, not hours"; "pays for itself on the first job / months of subscription" → "often pays for itself fast." Keep the punch, drop the hard numbers.
2. **CRM Integration (Page 7) stays public, hedged as roadmap.** Keep "Vonigo today, more CRMs on the roadmap" framing. **Implementation caveat:** Vonigo connect currently attaches to the shared Junkluggers tenant (`saveVonigoCredentials` hardcodes it), so it's effectively Junkluggers-internal today — a non-junkluggers operator can't truly connect yet. The public page is forward-looking; don't imply instant self-serve CRM connect for the general public.
3. **Build all 7 pages** in the first pass, from one shared template.
4. **Screenshots: real images, captured by the owner, dropped in later.** Build with `<img>` slots that degrade to a styled placeholder until the file exists (see below). "Replace later as the site evolves."
5. **Homepage links from `/features/*` are root-relative** — `/#features`, `/#trial`, `/` — NOT `index.html#...` (which resolves under `/features/`).
6. **SEO additions:** each page also gets Open Graph (`og:title`, `og:description`, `og:type`, `og:url`) + a `<link rel="canonical">`, in addition to `<title>`/`description`.
7. **Features dropdown** adds net-new component CSS (`.dropdown`, `.dropdown-menu`, `.nav-links`) — allowed exception to "no new tokens" (it reuses existing color tokens). Must work on tap (mobile), not just hover.

### Screenshot slot pattern (graceful placeholder)
```html
<figure class="shot">
  <img src="img/<name>.png" alt="<description>" loading="lazy"
       onerror="this.closest('.shot').classList.add('shot--empty')">
  <figcaption>[ Screenshot: <label> ]</figcaption>
</figure>
```
```css
/* image shows normally; until the file exists, .shot--empty shows the dashed box */
.shot{border-radius:var(--radius);overflow:hidden;}
.shot img{display:block;width:100%;height:auto;}
.shot figcaption{display:none;}
.shot--empty{border:1px dashed var(--border);background:var(--tile);min-height:240px;
  display:flex;align-items:center;justify-content:center;}
.shot--empty img{display:none;}
.shot--empty figcaption{display:block;color:var(--muted);font-family:var(--mono);font-size:13px;}
```
Files live in `marketing/features/img/`. A shot-list (filename ↔ app screen ↔ framing) is delivered with the build.

_Brief relocated from `marketing/` (public Cloudflare output dir) to `docs/` so the internal brief isn't served at crewlogicai.com._
