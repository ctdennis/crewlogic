# Plan — AI-Drafted Initial Customer Contact Email for Estimates (FW-70)

**Status:** IDEA CAPTURED / awaiting sample corpus + owner direction · created 2026-08-21 · no code
**Register:** FW-70 (`.HUB/Hub.md` Future-Work Register)
**Related:** `crewlogic-ai` edge function (existing AI surface), the Estimate editor / PDF-send flow, reverse-estimate mode.

---

## What it is
When an estimate is ready to send, the AI reads what's actually in the estimate (rooms/areas,
items, charges — disposal vs labor vs equipment, on-site-vs-haul options, special terms, notes
from the walkthrough) and drafts the **initial contact email to the customer** that goes out with
the estimate. The estimator reviews/edits, then sends. Goal: a warm, specific, human-sounding note
that references the real details of the job — not a generic template.

## Owner's reference sample (camper removal)
> Bob,
>
> Apologies for the delay — your estimate for the camper removal is attached.
>
> The estimate includes both the disposal and the labor for the skid steer. When we spoke, you
> mentioned your property may have enough room to handle that portion of the work on site, which
> would let us avoid some of the transportation charges.
>
> One thing worth noting: the skid steer does tear up the grass a bit, so it's best done in an area
> that isn't landscaped.
>
> Happy to discuss at your convenience.
>
> Charles

**What this sample teaches the prompt (voice/structure to encode):**
- First-name greeting; brief, personal, no corporate boilerplate.
- Opens by naming the specific job ("your estimate for the camper removal is attached").
- Explains what the estimate *includes* in plain language (disposal + skid-steer labor).
- Surfaces a **cost-saving option** tied to something the customer said (on-site handling avoids
  transportation charges) — i.e. it weaves in walkthrough context, not just line items.
- Adds a genuinely helpful **caveat/expectation** ("skid steer tears up the grass").
- Warm, low-pressure close + signs off with the estimator's first name.

## Sample 2 (proposal tone — "not to exceed" property cleanout)
> Hello Mike,
>
> Thank you for the opportunity to prepare this proposal for the removal of items from your
> property at 62 Park Street in Taunton. We truly appreciate the chance to work with you.
>
> This is a not to exceed estimate so we will not go over this price unless additional items are
> added. However, if the items take up less space, then, the price will come down accordingly.
>
> Our team is fully insured, professionally trained, and takes a thoughtful, detail-oriented
> approach to each project—especially when items may have personal, creative, or reuse value.
> Whenever possible, we prioritize donation, repurposing, and keeping items out of the landfill.
>
> Please don't hesitate to reach out if you have any questions about the estimate below or if
> there's anything you'd like us to handle with particular care.
>
> We look forward to the opportunity to assist you.
>
> Charles Dennis

**What Sample 2 adds to the style guide (vs Sample 1):**
- A **more formal / proposal register** — the model must range from Sample 1's casual, familiar
  note ("Bob, apologies for the delay…") to this warmer-but-professional proposal voice. Tone is
  not one fixed template; it flexes with job type / customer.
- Names the **property address** explicitly ("62 Park Street in Taunton").
- Explains the **"not to exceed" pricing structure** in plain language (won't exceed unless items
  are added; comes down if the load is smaller) — a pricing *mechanic*, described, never a number.
- Leads with **trust/credibility** (insured, trained, detail-oriented) and the **values pitch**
  (donation, repurposing, landfill diversion) — worth surfacing when the job involves items with
  "personal, creative, or reuse value."
- Invites the customer to flag anything to **handle with particular care**.
- Full-name sign-off here vs first-name in Sample 1 → **signature style is a variable**, likely a
  per-estimator/franchise setting.

**Cross-sample takeaway for the prompt:** two distinct registers (casual follow-up vs formal
proposal) from the same author. The prompt should pick/blend register from cues in the estimate
(job type, customer relationship, whether reuse-value items are present) rather than emit one fixed
template — and expose a light tone/formality control for the estimator.

## Open questions (to resolve once the sample corpus is in)
- **Sample corpus:** owner to provide several more examples (different job types) → these become the
  few-shot examples / style guide for the prompt. The corpus is the key input; hold prompt design
  until it's in.
- **Inputs to the model:** which estimate fields feed it (charges breakdown, item names, special
  terms, walkthrough notes/transcript, customer first name, estimator name/signature). Walkthrough
  context ("when we spoke, you mentioned…") is what makes the sample shine — need a place that
  captures those notes if we want the AI to use them.
- **Where it lives in the flow:** a "Draft intro email" button on the estimate/PDF-send screen →
  editable text area → copy/send. Reuses `crewlogic-ai`; consumes the AI-calls meter.
- **Model tier:** customer-facing prose (not identifiers) → Sonnet-class is fine.
- **Tone controls:** per-franchise signature/sign-off; optional formality dial.
- **Delivery:** draft-only (estimator copies into their mail client) vs send-through-app. Likely
  draft-only first (lowest risk, no email-deliverability surface).

## Guardrails
- Draft is **always estimator-reviewed before sending** — never auto-sent.
- No pricing numbers invented; the email describes what's in the estimate, doesn't recompute it.
- Additive to the estimate flow; no change to pricing/PDF/Vonigo submit.

## Next step
Owner provides the additional sample emails → build the prompt (few-shot from the corpus) → wire a
"Draft intro email" action on the estimate send flow (dev first). No build until the corpus is in.
