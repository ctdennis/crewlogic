# Competitive Landscape — CrewLogicAI

**Created:** 2026-06-23 · **Owner:** charles.dennis@junkluggers.com
**Purpose:** Ground the pricing/monetization decision (see `plan-payments.md`) and marketing positioning in
real market data. Prior state: the plan assumed "no known market comp" — that's **wrong**; there is a direct
vertical competitor. Live web research (WebSearch/WebFetch + third-party review sites), 2026 sources.

> **Data quality:** Prices flagged ✅ verified (neutral source: vendor page / Tekpon / Capterra / GetApp) or
> ⚠️ unverified (single/biased source — e.g. a competitor's comparison page inflates rivals). Re-verify ⚠️
> rows before quoting externally. Vonigo's own site is bot-walled; Vonigo facts rest on 2026 third-party reviews.

---

## TL;DR — the read

1. **There is a direct competitor: QuoteIQ** — a junk-removal-specific CRM that already does **AI photo→volume
   estimating + dispatch + routing**, from **$29.99/mo**. CrewLogic is *not* in clean whitespace for the
   **native (non-Junkluggers)** market.
2. **But CrewLogic's real moat is the Vonigo angle.** Vonigo (what Junkluggers franchises run on) has **zero AI
   estimating** and no AI/voice dispatch. CrewLogic is the **AI layer on top of Vonigo** — QuoteIQ can't be that
   (it's a standalone CRM that would *replace* Vonigo). For the Vonigo/franchise market, CrewLogic has no direct comp.
3. **Horizontal FSM (Jobber/Housecall/ServiceTitan/Workiz) don't do junk-removal volume estimating.** They're
   shipping AI *voice/booking* agents, not AI *photo-volume* estimating. CrewLogic at $39–$129/**location** undercuts
   all of them and is per-location (not per-seat), which scales cheaper for multi-crew shops.
4. **Pricing implication:** value-leaning Pro/Enterprise is well-supported (no comp on the Vonigo side; far under
   horizontals). **Starter ($39) is the one exposed price** — QuoteIQ's $29.99 entry undercuts it for native buyers.

---

## 1. Direct vertical competitors (junk-removal + AI estimating)

### QuoteIQ — the direct competitor ⚠️/✅
Junk-removal-specific CRM. **AI Estimator** (customer texts a photo → AI analyzes volume + item types → market
price in <60s), Options/truck-load-tier pricing, scheduling/dispatch, route optimization, job costing, QuickBooks,
review collection. 14-day trial, no contract, **no per-user fees claim** but tiers are seat-banded.

| Tier | Price/mo | Users | Notable |
|---|---|---|---|
| Essentials | $29.99 ✅ | 1 | core CRM + AI estimator |
| Beginner | $74.99 ✅ | 2 | 4K photos, e-sign |
| Pro | $149.99 ✅ | 4 | job costing, QuickBooks, ClientHub (their "recommended") |
| Elite | $249.99 (⚠️ one source said $299) | 7 | **route optimization**, InstaQuote |
| Max | $399.99 (⚠️ one source said $699) | unlimited | unlimited users |

Source: myquoteiq.com pricing/best-software pages; Capterra. *(Top two tiers had conflicting numbers across pages — re-verify.)*

### WhatShouldICharge — AI estimating point tool ✅
Built for junk removal. Operator uploads customer photos → volume + itemized breakdown + price range in <30s,
no site visit. **$5 per estimate**, or credit packs (~70% off), **no subscription**. A pay-per-use alternative
to a subscription — relevant as a cheap a-la-carte option for the estimating piece only. Source: whatshouldicharge.app.

### Also seen (not deep-dived)
Vida AI Agent OS, Junk Removal 365, AIonX (AI volume estimates + load optimization). Worth a follow-up scan if
the native market becomes a focus.

---

## 2. The platform CrewLogic sits on — Vonigo

- All-in-one cloud FSM (est. 2005): online booking, scheduling, dispatch, routing/GPS, work orders, CRM, **manual
  estimating/quoting**, invoicing, payments, mobile field app. Target = multi-location / franchise / movers, "5–50 techs."
- **Pricing:** per-user — Starter $98 / Professional $119 / Premium $139 ⚠️ (GetApp; other sources "contact for quote",
  range $98–$500/mo). QuickBooks integration.
- **AI: NONE.** Multiple independent 2026 reviews describe estimating/dispatch as standard *manual* modules; **no AI
  photo estimating, no AI/voice dispatch.** (Caveat: vonigo.com itself was unreachable; a very recent unannounced
  feature can't be 100% ruled out, but there's zero signal.)
- **Why this matters:** CrewLogic adds exactly what Vonigo lacks (AI estimating, voice dispatch, fleet map, disposal
  routing) *without replacing it*. That's the defensible position QuoteIQ structurally cannot occupy.

Sources: Capterra, GetApp, Tekpon, fieldservicesoftware.io (2026 review pages).

---

## 3. Horizontal FSM (general home-services — not junk-specific)

| Platform | Pricing (USD/mo) | Junk volume AI estimating? | AI shipped | Route/fleet | Segment |
|---|---|---|---|---|---|
| **Jobber** | $39 / $119 / $199 (annual; ~$169/$349/$599 monthly) ✅ Tekpon | ❌ | AI Copilot (limited, not photo volume) | routing yes; GPS via FleetSharp add-on (hardware) | SMB |
| **Housecall Pro** | $79 / $189; MAX custom (annual) ✅ Tekpon | ❌ | "AI Team" = AI CSR/booking (add-on) | scheduling; GPS add-on | SMB |
| **ServiceTitan** | No public price; enterprise/custom (cited ~$1,800+/mo ⚠️) | ⚠️ enterprise "Titan Intelligence" only | Ti / Atlas AI | native | Enterprise |
| **Workiz** | ~low-$200s tiers ⚠️ (Standard/Pro/Ultimate) | ❌ | **"Genius"** — AI call answering, lead extraction, AI scheduler; **markets to junk removal** | GPS add-on | SMB |
| **Service Fusion** | ~$192 / $298 / $489, unlimited users ⚠️ | ❌ | limited | GPS add-on | SMB/mid |

*(⚠️ rows = single/secondary source; vendor pages are Cloudflare/JS-walled. Jobber/Housecall ✅ from Tekpon JSON-LD.)*

---

## 4. AI-in-FSM trend (2025–2026)
The wave is **AI voice/booking agents + AI dispatch**, NOT photo-volume estimating: Workiz **Genius** (AI receptionist,
targets junk removal), ServiceTitan **Titan Intelligence/Atlas**, Housecall Pro **AI Team**. **AI photo-volume
estimating is the least-served capability** among the horizontals — it's QuoteIQ (vertical) and CrewLogic that do it.

---

## 5. Where CrewLogic wins / is exposed

**Moat / wins**
- **Vonigo-integrated AI layer** — no one else is this; Vonigo has no AI and QuoteIQ would replace Vonigo, not extend it.
- **AI photo→cubic-yard volume estimating** tuned to junk — horizontals don't do it; matches QuoteIQ here.
- **Voice dispatch + disposal routing + fleet map (Motive/LinxUp)** — combination is distinctive.
- **Per-location pricing** (incl. seats) vs competitors' per-user — cheaper for multi-crew operations.

**Exposed / threats**
- **QuoteIQ** (direct, vertical, AI photo estimating, $29.99 entry) — the real competitor for the **native** market;
  cheaper entry than Starter.
- **Workiz** explicitly courts junk removal with AI booking; could add photo estimating.
- **Bundling risk** — a hauler already paying for Jobber/Housecall/QuoteIQ for CRM+invoicing may resist a second tool;
  CrewLogic must be the estimating/ops *brain* that complements (or, for native, replaces) the CRM.
- **Vonigo adding AI** — low signal today, but it's the platform; monitor.

---

## 6. Pricing implications (feeds `plan-payments.md`)
- **Pro/Enterprise value-leaning prices are well-supported.** For the Vonigo/Junkluggers market there's no direct comp,
  and $59–$129/location is far under Vonigo-per-user + any horizontal. The earlier "$39/$79/$129" idea holds up.
- **Starter ($39) is the pressure point** — QuoteIQ undercuts at $29.99 for the native buyer. Options: keep $39 and
  win on the Vonigo/AI-depth story (weak for *native*, who don't have Vonigo), drop Starter nearer $29, or position
  Starter as estimating-first vs QuoteIQ's full-CRM (different value).
- **Lead with the moat, not "AI":** the AI-booking space is crowded; CrewLogic's pitch is **AI photo-volume estimating
  accuracy + Vonigo integration + voice dispatch**, not generic "AI."
- **Founding-customer + proof-loop** (from plan §value discussion) still the right launch play given thin history.

---

## 7. QuoteIQ head-to-head — gap analysis (the one direct rival)

They overlap on AI estimating but **target different buyers**: QuoteIQ = the full **front office for a
standalone hauler**; CrewLogic = the **AI + ops layer on top of an existing CRM (Vonigo)**. They only truly
collide in the **native (non-Vonigo)** market. Pricing on QuoteIQ tiers varies across sources (recent
repricing/renames) — treat features as stable, prices as re-verify.

### Shared ground (both do)
AI photo→volume→price + truck-load tier pricing. **Different emphasis:** QuoteIQ's is a **customer self-serve
lead funnel** (text a photo / 24-7 website **InstaQuote** → instant price); CrewLogic's is **operator/estimator-
driven** (transcript + areas + photos → Vonigo workflow + PDF proposal). QuoteIQ estimating = a *sales* tool;
CrewLogic estimating = an *ops/accuracy* tool.

### Where QuoteIQ is AHEAD (gaps for CrewLogic) — almost all FRONT-OFFICE
- **Customer self-serve instant quote (InstaQuote, 24/7 on the website)** — lead-gen funnel CrewLogic lacks ← biggest gap
- **Online booking / customer self-scheduling** (InstaSchedule)
- **Invoicing + payment collection** (card/ACH/Apple/Google Pay) + recurring billing + tips
- **Full CRM** (contacts, Pipelines deal tracking, history) + **ClientHub** customer portal
- **Reviews/reputation** (Review Multiplier) and **marketing automation** (email/SMS campaigns, AI website builder)
- **Job costing/expense module** (dump fees, fuel, labor → per-load profit)
- **AI Before/After image render** + 4K photo docs (QuoteIQ Cam); **24/7 AI Virtual Call Team** (AI receptionist books jobs)
- Misc: e-signatures, QuickBooks (Pro+; one review disputes depth), MapMeasure, time tracking, inventory
- **BUT for franchises these mostly don't matter — Vonigo already provides booking/invoicing/payments/CRM.** They matter for the **native** market.

### Where CrewLogic is OUTSIDE QuoteIQ (differentiators) — almost all OPS + integration
- **Vonigo integration** — additive layer vs QuoteIQ's rip-and-replace CRM. **The decisive one for franchises** (QuoteIQ structurally can't be a layer on Vonigo).
- **Voice dispatch (Manage Jobs)** — move/cancel/resize against the *live schedule* with zone + availability logic. (QuoteIQ has "AI Autopilot" NL CRM commands — broader but not schedule-aware dispatch; CrewLogic is deeper on dispatch.)
- **Live telematics map (Motive + LinxUp)** — real ELD/GPS *hardware* integration. QuoteIQ's GPS = phone-based crew location only. Deeper.
- **Job Router** — truck→dump→next-job **disposal-site recommender**. QuoteIQ optimizes pickup routes but not disposal-site selection.
- **Job Plan** — AI morning crew brief. QuoteIQ has none.
- **National Accounts** AI crew-warning summary (corporate-account handling) — niche, QuoteIQ none.
- **Yard Signs gamification** (placement tracking + crew leaderboard) — QuoteIQ has reviews, not a signs lead-gen game.
- **Per-location pricing** (vs QuoteIQ's per-user bands) — cheaper for multi-crew.

### Strategic read
- **Franchise / Vonigo buyer → CrewLogic wins by default:** QuoteIQ can't layer on Vonigo, and the front-office "gaps" are already covered by Vonigo. CrewLogic's ops depth (voice dispatch, real telematics, disposal routing, crew brief, National Accounts) is unmatched here.
- **Native / non-Vonigo buyer → they collide, and CrewLogic is currently the WEAKER standalone:** it lacks the front office (booking, invoicing, payments, full CRM, marketing, reviews) that QuoteIQ ships. CrewLogic's native wedge is **AI estimating + the ops tools**, not an all-in-one CRM.
- **Highest-leverage gap to close (if chasing native):** a **customer-facing self-serve instant-quote widget** (an InstaQuote equivalent). CrewLogic already has the AI estimating engine — exposing it customer-facing is the single highest-value gap-closer: it's both the **revenue/lead-gen lever** and QuoteIQ's headline feature. Everything else QuoteIQ has (invoicing/payments/marketing/reviews) is a much bigger build and is already covered for the franchise market by Vonigo.

### Reviewer-noted QuoteIQ weaknesses (use in positioning)
Mobile-first with **limited web portal**; **basic reporting/analytics**; quote templates weak for **complex/specialized forms**; **tight user limits** at lower tiers; QuickBooks depth questioned. (mowingmagic, todaytesting, linktly 2026 reviews.)

## Sources
QuoteIQ: myquoteiq.com (pricing/best-software/CRM pages), Capterra QuoteIQ · WhatShouldICharge: whatshouldicharge.app ·
Vonigo: Capterra, GetApp, Tekpon, fieldservicesoftware.io · Jobber/Housecall: Tekpon pricing (JSON-LD, dateModified
2026) · Workiz: workiz.com/features/workiz-genius · ServiceTitan: servicetitan.com/features/titan-intelligence ·
Housecall AI: housecallpro.com/features/ai-team. (Full URLs in the research-agent transcripts for this session.)

## Caveats
- ⚠️ rows are single/secondary-source; vendor pricing pages are bot-protected. Re-verify Workiz, Service Fusion,
  ServiceTitan, and QuoteIQ's Elite/Max before using externally.
- "Vonigo has no AI" rests on 2026 third-party reviews (vonigo.com unreachable) — high confidence, not absolute.
- "No other junk AI-photo competitor" = *not found*, not *confirmed none*. QuoteIQ + WhatShouldICharge are confirmed.

## No follow-up actions required to track here
This doc feeds the pricing decision in `plan-payments.md`; the open pricing items live there.
