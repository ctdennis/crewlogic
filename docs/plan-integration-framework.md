# Plan — CRM Integration Framework (the common thread)

**Status:** DRAFT for Owner review · created 2026-07-18 · **revised 2026-07-19 with ServiceTitan spike results** · no code, no schema
**Author:** Claude (master), Sr. Architect hat
**Related:** `docs/crm-integration-field-inventory.md` (Vonigo field map + empty ServiceTitan column), `docs/plan-native-scheduling.md` (native jobs/scheduling), `docs/plan-payments.md` (SaaS billing — distinct from customer payments)

---

## 0. Revision note — what the spike changed

The 2026-07-18 draft made three recommendations that the ServiceTitan API spike **disproved**. Recorded here rather than quietly edited, because the reasoning matters:

| Original recommendation | Reality | Now |
|---|---|---|
| "Webhook-first, reconcile-always" | ST webhooks are **V2 Beta**, event catalog not public, replay "under development", retries stop at ~6.7 min | **Poll-first** (§6.3) |
| `external_refs.external_version` for conflict detection | ST has **no ETag/rowversion** anywhere | Conflict detection is not available; ownership discipline replaces it (§6.1) |
| Invoice: CrewLogic `issue(job)` → CRM | ST **auto-creates** the invoice at job booking; `POST /invoices` is adjustment-only | Find-and-update-before-posted (§5.3) |

A fourth claim made in conversation — that CrewLogic could capture payment in Stripe and write it back via `POST /payments` — was **wrong**: that endpoint does not exist. See §5.4.

**Sourcing note.** `developer.servicetitan.io/docs/*` is a JS SPA and unreadable by fetch. All schema claims below come from the **public, unauthenticated OpenAPI endpoint** the portal's own bundle calls: `developer.servicetitan.io/api/docs/apis[/{apiId}]`. Claims sourced only from help-docs or third-party connectors (Prismatic, Celigo) are marked **unverified**.

---

## 1. What this document answers

Owner, 2026-07-18: *"very crisply define what things would be passed back and forth if [an external CRM] were to handle customers, scheduling, invoices, payment processing… we should have a common thread for integration… best practices for getting information in and out."*

1. **The ownership contract** — per entity, who holds the truth and which way data moves (§4). This is the crisp definition; everything else follows.
2. **The common thread** — one pattern every provider uses, so ServiceTitan is not a bespoke build (§6).
3. **The gap analysis** — now filled for ServiceTitan (§7).

---

## 2. Principle 1 — canonical model is CrewLogic's; providers are adapters **[Q-1 ANSWERED]**

`plan-native-scheduling.md` §3 proposed mirroring the Vonigo WorkOrder shape so the dispatch UI source-swaps unchanged. **The spike settles this: mirroring is not viable.** Vonigo and ServiceTitan are opposites on the most error-prone axis:

| | Vonigo | ServiceTitan |
|---|---|---|
| Time convention | **naive-Eastern** (clock face stored as UTC) | **explicit UTC** — "(in UTC)" verbatim on every JPM datetime |
| Entity split | Job → WorkOrder | Project → **Job → Appointment → Assignment** |
| Duration | `durationMin` field (186) | **no duration field** — derived `end − start`; duration is a property of Job Type |
| Routes | first-class routes | **no route entity** — Business Unit / Zone / Team |
| Scheduled time lives on | WorkOrder | **Appointment** (Job carries no time at all) |

A canonical model shaped like Vonigo would force every ServiceTitan datetime through a naive-Eastern representation — encoding a competitor's quirk as the interchange format. **Decision: canonical-first.** CrewLogic owns the entity definitions; Vonigo becomes an adapter with the same status ServiceTitan has.

**Canonical time rule:** store an **instant (UTC) + the franchise IANA timezone**, and let each adapter render its own convention — naive-Eastern for Vonigo, true UTC for ServiceTitan. Every franchise now carries an explicit `cost_settings.officeTimezone` (migrations 0050/0051, 2026-07-18) and `_shared/tz.ts` is the single resolver, so this prerequisite is **already in place**.

**Mapping consequence:** our canonical Job maps to a ServiceTitan **Appointment**, not their Job (theirs holds N appointments). Vonigo's WorkOrder is the equivalent grain. Getting this wrong at schema time is expensive later.

---

## 3. Principle 2 — capability axes, not provider-per-tenant

Existing seam (`migration 0004`, `tenants`), per-**capability** so providers can mix:

| Existing axis | Values | No CHECK constraint → new values need no migration |
|---|---|---|
| `pricing_source` | `vonigo` \| `native` | ✅ |
| `customer_source` | `vonigo` \| `native` | ✅ |
| `submission_target` | `vonigo` \| `none` | ✅ |

**Axes to add:** `job_source` (`native`\|`vonigo`\|`servicetitan`), `invoice_source` (`native`\|`servicetitan`\|`quickbooks`), `payment_processor` (`none`\|`stripe`\|`external`).

**Guardrail:** adding a provider must never require a core-code change outside its adapter module. If it does, the abstraction leaked.

---

## 4. Principle 3 — ONE system of record per entity (the crisp part)

Bidirectional sync without a declared owner is how integrations become unfixable. Ownership, **revised for what ServiceTitan actually permits**:

| Entity | System of record | Direction | ServiceTitan reality |
|---|---|---|---|
| **Customer** | CRM | read; create-on-first-use | ✅ full CRUD. Note Customer→**many Locations**; `POST /customers` requires `locations[]` |
| **Job / appointment** | CRM | read; write create/reschedule/cancel/assign | ✅ create, reschedule, cancel job, assign techs. ⚠️ **cancel a single Appointment: no endpoint** (only DELETE) |
| **Estimate** | **CrewLogic** | push to CRM | The estimating engine + photo AI **is the product**. Never delegate. |
| **Price book** | either (`pricing_source`) | read | ST is pricebook-centric; module exists |
| **Invoice** | CRM | **update**, not create | ST auto-creates at booking; edit window closes `Pending→Posted→Exported` |
| **Payment** | **CRM (not us)** | **read only** | ⚠️ **No payment-create endpoint at all.** See §5.4 |
| **Crew / trucks / telematics** | **CrewLogic** | none | Already CRM-independent — keep it that way |

**The payment row is the one that changed.** The draft assumed processor → CrewLogic → `mark_paid` in the CRM. For ServiceTitan that last hop is impossible, which makes CrewLogic-captured payment unreconcilable for those tenants (money in Stripe, invoice in ST with no way to record it). **Payment capture is therefore a native-tenant capability**, not a universal one.

---

## 5. The data-flow contract, per capability

Canonical field names, not any provider's.

### 5.1 Customers
- **In:** `external_id, name, company?, phones[], emails[], addresses[], is_commercial, tags[]`
- **Out:** create-on-first-use only. CrewLogic never edits CRM customer master data it did not create.
- **Trigger:** search-on-demand (typeahead) + delta poll. No full-table sync.
- **ST shape notes:** discrete filters (`name`, `phone`, `street/city/state/zip`), **no free-text `q`**. `phones[]`+`emails[]` → one `contacts` list discriminated by `type`. `addresses[]` → Customer.address + N **Location** entities. `tags[]` → tenant-configured integer `tagTypeIds`, not free text. `company` → no equivalent (only `name` + `type`).

### 5.2 Jobs / scheduling
- **In:** `external_id, customer_ref, address, scheduled_start (UTC instant), duration_minutes, status, crew_refs[], items_description, notes_internal?`
- **Out:** `create`, `reschedule`, `set_duration`, `cancel`, `assign_crew`
- **ST required-on-create fields we do NOT capture:** **`businessUnitId`, `jobTypeId`, `campaignId`, `priority`, `locationId`** — plus cancel needs `reasonId` + `memo`. **A per-tenant reference-data sync (business units, job types, campaigns, cancel reasons) is a hard prerequisite for any job write.** If we only ever *read* ST jobs, this whole burden disappears — see Q-2.
- **No canonical equivalent in ST:** `route_ref` (no route entity), `price_estimate` (Job `total` is read-only).
- **Availability:** `POST /dispatch/v2/.../capacity` returns **hours of open availability per time frame**, not discrete bookable start times. Our online-booking slot model cannot assume a slot list.

### 5.3 Invoices
- **Out:** update an **existing** invoice — `PATCH /invoices/{id}`, `POST /invoices/{id}/items`
- **In:** `balance`, `total`, `reviewStatus`, `sentStatus`
- **✅ Verified good news — arbitrary line items are allowed.** `Accounting.V2.InvoiceItemUpdateRequest` has `"required": ["description", "quantity"]`; `skuId` is optional and nullable. So CrewLogic estimate lines can push **without** mapping to a pricebook SKU. (Price field is **`unitPrice`**.) Worth one sandbox test — a `required` array cannot express server-side business rules.
- **`POST /invoices` is adjustment-only** — operationId `Invoices_CreateAdjustmentInvoice`, `"required": ["adjustmentToId"]`. No general invoice create exists.
- **Tax is ST-computed.** `salesTax` appears only on response models; writable tax fields are `tax` + `taxZoneId`.
- **No single status enum.** `InvoiceSentStatus` `["NotSent","Sent","Opened"]` and `InvoiceReviewStatus` `["NeedsReview","OnHold","Reviewed","PendingApproval","Rejected","ReadyForBilling","Invoiced"]`; only `reviewStatus` is writable. **Paid/unpaid must be derived from `balance` vs `total`.**

### 5.4 Payments — **ServiceTitan cannot be a payment target**
Verified across **all 24 module specs** (accounting, crm, dispatch, jpm, pricebook, memberships, payroll, salestech, settings, telecom, … full list in the summary doc): **zero** operations matching charge / authorize / capture / refund / tokenize / paymentMethod / creditCard / gateway.

Stronger than "no card processing": **there is no payment-create endpoint at all.** `/payments` is GET-only; writes are `PATCH /{id}` and `POST /status`. `authCode` exists as a plain string you *record*, not one that triggers authorization. Only near-miss is `memberships.paymentMethodId`, which references a method created in their UI with no API to create, list, or charge it.

**Consequences:**
1. A crew member **cannot** take a card through CrewLogic for a ServiceTitan tenant.
2. CrewLogic **cannot** write back a payment captured elsewhere — payments must originate in ServiceTitan (Mobile app / Transaction Gateway UI).
3. Therefore for ST tenants: payment is **ST-owned end-to-end**; CrewLogic reads `balance`/`total` to know an invoice is settled.
4. **Native payment capture (Stripe) is a native-tenant feature.** It does not generalise to ServiceTitan. Budget it as native product value, not shared integration infrastructure.

*Confidence:* schema-verified negative across all modules. Still worth one question to ServiceTitan developer support before it becomes a permanent constraint — an undocumented partner-only capability would not appear in the public spec.

---

## 6. The common thread — mechanics every adapter shares

### 6.1 One external-reference table, not per-provider columns
```
external_refs(entity_type, crewlogic_id, provider, external_id,
              external_version, last_synced_at,
              unique(entity_type, provider, external_id))
```
Adding a provider adds **rows, not columns** — and stops `vonigo_job_id` landing on `jobs`, which would not generalise.

⚠️ **`external_version` will be NULL for ServiceTitan** — no ETag/rowversion exists anywhere in their API, so optimistic-concurrency conflict detection is unavailable. Ownership discipline (§4) is the mitigation: if the CRM owns the job, CrewLogic writes only deltas the user explicitly requested and never blind-overwrites a whole record.

✅ **Use `externalData`.** ServiceTitan supports an `externalData` bag plus `externalDataKey`/`externalDataValues` **filters**, so CrewLogic IDs can be stamped onto their records and queried back. That gives genuine bidirectional mapping and makes reconciliation far cheaper than an `external_refs`-only design. Prefer it wherever a provider offers an equivalent.

### 6.2 Declarative field mapping, not imperative translation code
Each adapter ships a **mapping manifest** (data, not code): canonical field → provider field, plus enum maps. Vonigo's numeric field IDs (`181` status, `201` label, `9082` time) and ServiceTitan's tenant-configured `tagTypeIds`/`jobTypeId`/`businessUnitId` become manifest entries rather than constants strewn through handlers. A new CRM becomes *a manifest plus auth*.

### 6.3 **Poll-first, webhook-as-optimization** *(inverted from the draft)*
- ServiceTitan webhooks are **V2 Beta**: CloudEvents, optional HMAC via `X-Signature`, retries at **10/30/60/300s only** (~6.7 min total), replay **still under development**, and the **event catalog is not public**. Adding an event post-launch forces **every existing customer to re-approve** a new app version.
- Therefore: **delta polling is the system of record.** ST supports `modifiedOnOrAfter`/`modifiedBefore` broadly. Webhooks are a latency optimization layered on top, never the only path.
- ⚠️ **Deletes are invisible to a `modifiedOnOrAfter` poller** — they surface only via `/export`. A deleted job simply stops appearing, indistinguishable from falling out of the window. Any reconcile must diff a bounded window against local state, not just consume "changed since".
- **Precedent:** CrewLogic already runs webhook + periodic reconcile for Motive/Linxup geofences (`GEOFENCE_RECONCILE`). The 2026-07-02 incident — a wrong signing secret meant every crossing 401'd **silently** while events appeared to fire — is exactly why the reconcile is not optional. Reconcile discrepancies must log loudly, never self-heal quietly.

### 6.4 Idempotency is **entirely ours to provide**
ServiceTitan documents **no** idempotency-key support (0 occurrences, 0 header params across the CRM and JPM specs). So:
- A retried `POST` **duplicates the record in the customer's live CRM**. This is the single largest correctness risk in the whole integration.
- Concurrent writes are silently last-write-wins, with no version field to detect the conflict.
- **The outbox (§6.5) stops being a nice-to-have.** Exactly-once outbound delivery must be enforced on our side: dedupe key per `(entity, operation, intent)`, persisted before the call, checked after — and on ambiguous failure (timeout), **read back before retrying**, never blind-retry a create.

### 6.5 Outbox for outbound writes
Never call a provider inline from a request handler. Write intent to `integration_outbox`, return to the user, drain asynchronously with retry + backoff. Prevents a CRM outage from breaking CrewLogic's UI, gives a durable audit of what was sent, and is where §6.4's exactly-once discipline lives.

### 6.6 Capability matrix + graceful degradation
Each adapter declares what it supports (`can_create_job`, `can_cancel_appointment`, `can_capture_payment`, …); the UI reads capabilities and hides or explains what a provider cannot do. Concrete cases already known: ST cannot cancel a single appointment; ST cannot capture payment; Vonigo cannot cancel one appointment of a multi-appointment job (shipped as a guard with an explanatory message — the right degradation shape, now generalised).

### 6.7 Error surface discipline
Adapter errors log fully server-side (provider, operation, external id, response); clients get a stable code + safe message. No provider payloads, tokens, or internal ids in client responses.

### 6.8 Auth + onboarding is per-tenant, and manual
ServiceTitan: OAuth2 **client-credentials only**, **900s tokens, no refresh**, required `ST-App-Key` header, `tenant` as a required path segment. Critically: **`client_id`/`secret` are per-tenant** — *"if you have an application that will be used by 10 ServiceTitan customers, you need 10 client IDs and secrets."* Each franchise's admin generates and hands them over out-of-band after we pre-add their tenant ID. Rate limit **600 calls / 10s per app per tenant**.

Design implication: credential storage must be **per-franchise** (CrewLogic already does this for Vonigo via Vault — reuse that pattern), and onboarding a franchise is a **manual, supported step**, not self-serve.

---

## 7. Gap analysis — ServiceTitan (filled 2026-07-19)

| Question | Customers | Jobs | Invoices | Payments |
|---|---|---|---|---|
| Read supported | ✅ filters, no free-text | ✅ `startsOnOrAfter` etc. | ✅ by `jobId`/`customerId` | ✅ GET only |
| Write supported | ✅ create + patch | ✅ create/reschedule/cancel/assign; ✗ cancel single appointment | ⚠️ **update only** (auto-created; create = adjustment only) | ❌ **none** |
| Webhook available | Beta, catalog not public | Beta | Beta | Beta |
| Event latency / guarantee | retries ≤ ~6.7 min, no replay | same | same | same |
| Auth model | OAuth2 client-credentials, per-tenant secrets, `ST-App-Key` | same | same | same |
| Rate limits | 600 / 10s / app / tenant | same | same | same |
| Idempotency | ❌ none | ❌ none | ❌ none | n/a |
| Version/etag | ❌ none | ❌ none | ❌ none | ❌ none |
| Sandbox | ⚠️ Integration env, **gated behind partnership agreement** | same | same | same |
| Fields we don't capture | Location entity | **businessUnitId, jobTypeId, campaignId, priority, locationId** | `taxZoneId` | n/a |
| Their required fields with no canonical equivalent | Locations[] on create | job type ⇒ duration | — | n/a |

**Business dependencies (not engineering):**
- **Marketplace certification is a 5-stage gated program** (Apply → Discovery Call → Review & Proposal → partnership agreement → Certification) and it gates **the sandbox itself**, not just launch. Permitted endpoints are negotiated per-partner.
- **"Tunneled Apps" are explicitly Not Allowed** — no compliant shortcut.
- Adding a webhook event or scope post-launch forces every existing customer to re-approve.

**Zapier:** Owner noted ServiceTitan integrates via Zapier. Treat that as **evidence the operations exist**, not as production transport — third-party dependency, per-task cost, latency wrong for a live dispatch board, no idempotency. Confirm during partner onboarding whether their Zapier triggers are webhook-backed or polling; that answers §6.3's latency question for free.

---

## 8. What this means for sequencing

1. **Canonical-first is settled** (§2). The `jobs` schema can now be drafted against a canonical model, not a Vonigo mirror.
2. **Native payment capture is native-only value** (§5.4). Still worth building — Owner's north star — but it does not amortise across ServiceTitan.
3. **ServiceTitan is partnership-gated.** Certification and per-tenant credentials sit in front of the engineering. If ST integration matters commercially, **the partner application is the long pole and should start before any code.**
4. **Read-only ServiceTitan is dramatically cheaper than read-write.** Dropping job *creation* removes the entire per-tenant reference-data sync (business units, job types, campaigns, priorities). Worth deciding deliberately — see Q-2.
5. **Vonigo stays as-is** behind the seam until a second CRM proves the interface. It works; the framework must not become a rewrite of a working integration.

## 9. Open questions

- **Q-1. Canonical-first vs mirror-Vonigo — ANSWERED 2026-07-19: canonical-first.** Vonigo and ServiceTitan are opposites on time convention, entity grain, duration, and routes; no mirror serves both.
- **Q-2. Read-only or read-write for ServiceTitan?** Read-only (CrewLogic estimates + dispatch view, ST owns booking) avoids the reference-data sync entirely and cuts scope hard. Read-write lets CrewLogic book jobs into ST. *Lean: read-only for v1; add writes once a real customer needs them.*
- **Q-3. Native invoicing depth** — issue + mark-paid, or full AR (aging, reminders, statements)? *Lean: issue + mark paid for v1; AR is an accounting product.*
- **Q-4. Does ServiceTitan integration matter enough to start the partner application now?** It is the long pole and is pure business process — it can run in parallel with all native work at zero engineering cost.
- **Q-5. QuickBooks as `invoice_source`?** A QBO integration already exists (`crewlogic-quickbooks`, super-admin/#90-internal), so auth groundwork is partly done. Possibly a better invoicing target than any CRM.
- **Q-6. Confirm the payment negative with ServiceTitan developer support** before treating it as permanent — an undocumented partner-only capability would not appear in the public spec.

## 10. Follow-up actions

- [ ] Owner decision on Q-2 (read-only vs read-write) — sizes the ServiceTitan build
- [ ] Owner decision on Q-4 (start partner application?) — long pole, zero engineering cost
- [ ] Fill the ServiceTitan column in `docs/crm-integration-field-inventory.md` from §5 + §7 here
- [ ] Draft the `jobs` schema + `crewlogic-jobs` contract against the canonical model (Q-1 now unblocks this)
- [ ] Sandbox-test the non-pricebook invoice line item (§5.3) if/when Integration-env access exists
- [ ] Ask ST developer support the §5.4 payment question (Q-6)

**Spike source docs:** `scratchpad/st-mechanics.md`, `st-customers-jobs.md`, `st-invoices-payments.md`, `st-accounting-verified.md`
