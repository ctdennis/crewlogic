# Plan — CRM Integration Framework (the common thread)

**Status:** DRAFT for Owner review · 2026-07-18 · no code, no schema
**Author:** Claude (master), Sr. Architect hat
**Related:** `docs/crm-integration-field-inventory.md` (the Vonigo field-level map + empty SFDC/ServiceTitan columns), `docs/plan-native-scheduling.md` (native jobs/scheduling), `docs/plan-payments.md` (SaaS billing — distinct from customer payments)

---

## 1. What this document answers

Owner, 2026-07-18: *"very crisply define what things would be passed back and forth if [an external CRM] were to handle customers, scheduling, invoices, payment processing… we should have a common thread for integration… best practices for getting information in and out based on that common pattern."*

So this doc defines **three** things, in order:

1. **The ownership contract** — for each entity, who holds the truth and which direction data moves. This is the crisp definition; everything else follows from it.
2. **The common thread** — one integration pattern every provider uses, so ServiceTitan is not a bespoke build.
3. **A gap-analysis template** — the questions to answer against any CRM's API. Fill it during the spike; the empty cells ARE the gap list.

**Non-goal:** ServiceTitan API specifics. Nothing about their endpoints, auth, rate limits, or write permissions is asserted here — that is the spike's job (§7). Designing an interface around assumed API behaviour is how integrations get rebuilt twice.

---

## 2. Principle 1 — the canonical model is CrewLogic's, providers are adapters

**Decision to make (gates the `jobs` schema):** does CrewLogic's internal job shape mirror Vonigo's WorkOrder, or is it CrewLogic's own with Vonigo as one adapter among many?

`plan-native-scheduling.md` §3 proposes mirroring the Vonigo WorkOrder so the existing dispatch UI source-swaps unchanged. That is the cheapest path to shipping native — and the wrong foundation for a multi-CRM framework, because every future adapter would then translate into a *Vonigo-shaped* model and inherit its quirks: the Job-vs-WorkOrder split, numeric field IDs (`181` status, `201` label, `9082` time), the naive-Eastern date convention. `crm-integration-field-inventory.md` §5 is literally titled *"Vonigo-isms / porting risks — design these away for a clean multi-CRM layer."*

**Recommendation: canonical-first.** CrewLogic owns the entity definitions. Vonigo becomes an adapter with exactly the same status ServiceTitan will have. Native stops being "the CRM-less fallback" and becomes **the reference implementation** — which is also what makes the native product (§ Owner's north star: estimates + invoicing + scheduling + payments) coherent rather than a stripped-down Vonigo clone.

Cost: the dispatch UI needs a mapping layer instead of a straight source-swap. Paid once, at the moment the `jobs` table is designed — which is now.

```
            ┌──────────────────────────────────────────┐
  UI  ─────►│  CrewLogic canonical model (jobs,        │
            │  customers, invoices, payments)          │
            └───────────────┬──────────────────────────┘
                            │  capability ports
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   native adapter     vonigo adapter    servicetitan adapter
   (own tables)       (REST + fieldIDs)  (REST + webhooks/Zapier)
```

---

## 3. Principle 2 — capability axes, not provider-per-tenant

CrewLogic already has this seam (`migration 0004`, `tenants` columns), and it is per-**capability** — a tenant can mix providers:

| Existing axis | Values today | No CHECK constraint → new values need no migration |
|---|---|---|
| `pricing_source` | `vonigo` \| `native` | ✅ |
| `customer_source` | `vonigo` \| `native` | ✅ |
| `submission_target` | `vonigo` \| `none` | ✅ |

**Axes that must be added** for the north star:

| New axis | Values | Controls |
|---|---|---|
| `job_source` | `native` \| `vonigo` \| `servicetitan` | where jobs/appointments live |
| `invoice_source` | `native` \| `servicetitan` \| `quickbooks` | who issues + owns invoices |
| `payment_processor` | `none` \| `stripe` \| `servicetitan` | who captures customer money |

Composition is the point: a tenant might run **ServiceTitan customers + ServiceTitan scheduling + native estimates + Stripe payments**. If integration were per-tenant-provider instead of per-capability, that combination would be impossible.

**Guardrail:** adding a provider must never require a core-code change outside its own adapter module. If it does, the abstraction leaked.

---

## 4. Principle 3 — ONE system of record per entity (the crisp part)

The single question that prevents integration rot: **for each entity, exactly one side owns the truth.** Bidirectional "sync" without a declared owner is how integrations become unfixable — both sides overwrite each other and nobody can say which value is correct.

Proposed ownership when an external CRM handles customers/scheduling/invoicing/payments:

| Entity | System of record | Direction | Why |
|---|---|---|---|
| **Customer** | CRM | CRM → CrewLogic (read), CrewLogic → CRM (create-on-first-use) | The CRM is the book of business; duplicating customer master data is the classic failure |
| **Job / appointment** | CRM | CRM → CrewLogic (read, near-real-time), CrewLogic → CRM (write: create, reschedule, cancel, duration) | Dispatch happens in CrewLogic but the CRM's calendar is what the office trusts |
| **Estimate / quote** | **CrewLogic** | CrewLogic → CRM (push on win) | The estimating engine, photo AI, and volume math ARE the product. Never delegate. |
| **Price book** | either (per `pricing_source`) | CRM → CrewLogic (read) or native | Already solved by the existing axis |
| **Invoice** | CRM (when present) | CrewLogic → CRM (issue from completed job), CRM → CrewLogic (status: sent/paid/void) | Accounting lives with the CRM/GL; CrewLogic should not become a second ledger |
| **Payment** | processor | processor → CrewLogic (webhook), CrewLogic → CRM (mark paid) | Money state comes from the processor, never inferred |
| **Crew / truck / telematics** | **CrewLogic** | none | Already CRM-independent (Vault creds, `franchise_trucks`) — keep it that way |

**Read this as the gap list generator.** For each row, the spike asks: *can their API support this direction, at this freshness, with these fields?* Every "no" is a gap, and each gap has exactly three resolutions: (a) degrade the capability, (b) shift ownership to CrewLogic, (c) don't support that CRM for that axis.

---

## 5. The data-flow contract, per capability

What actually passes back and forth. Fields are canonical names, not any provider's.

### 5.1 Customers
- **In (CRM → CL):** `external_id, name, company?, phones[], emails[], addresses[{line1,city,state,zip,lat?,lng?}], is_commercial, tags[]`
- **Out (CL → CRM):** create-on-first-use only, same shape. CrewLogic never edits CRM customer master data it did not create.
- **Trigger:** search-on-demand (typeahead) + webhook on change. No full-table sync.

### 5.2 Jobs / scheduling
- **In:** `external_id, customer_ref, address, scheduled_date, start_minutes, duration_minutes, status, route_ref?, crew_refs[], items_description, notes_internal?, price_estimate?`
- **Out:** `create(job)`, `reschedule(job, date, start)`, `set_duration(job, minutes)`, `cancel(job, reason)`, `assign_crew(job, crew[])`
- **Trigger in:** webhook preferred; polling reconcile as the safety net (§6.3)
- **Freshness requirement:** near-real-time. The dispatch board is a live surface; a 15-minute-stale board is worse than no board.

### 5.3 Invoices
- **Out:** `issue(job) → {line_items[{sku?,description,qty,unit_price}], subtotal, discounts[], taxes[], total, due_date, terms}`
- **In:** `status` transitions (`draft|sent|paid|partial|void`), `amount_paid`, `paid_at`
- **Trigger out:** job → `completed`. **Trigger in:** webhook on invoice status change.
- **Note:** CrewLogic issues from the completed job; it does not maintain an AR ledger. That stays with the CRM/GL.

### 5.4 Payments
- **In (processor → CL):** `payment_id, amount, currency, method, status, captured_at, tip_amount?, job_ref` via webhook, signature-verified
- **Out (CL → CRM):** `mark_paid(invoice_ref, payment_id, amount, captured_at)`
- **Never** infer payment from UI state. The processor webhook is the only source of truth for money.

---

## 6. The common thread — mechanics every adapter shares

These are the "best practices for getting information in and out." Provider-agnostic; build once.

### 6.1 One external-reference table, not per-provider columns
```
external_refs(
  entity_type,        -- 'customer' | 'job' | 'invoice' | 'payment'
  crewlogic_id,       -- our UUID
  provider,           -- 'vonigo' | 'servicetitan' | ...
  external_id,        -- their id (text — never assume numeric)
  external_version,   -- etag / updated_at / rowversion, for conflict detection
  last_synced_at,
  unique(entity_type, provider, external_id)
)
```
Adding a provider adds **rows, not columns**. This also kills the temptation to stash `vonigo_job_id` on the `jobs` table, which does not generalise.

### 6.2 Declarative field mapping, not imperative translation code
Each adapter ships a **mapping manifest** (data, not code): canonical field → provider field, plus enum maps. Vonigo's numeric field IDs and option IDs (`181` status, `201` label, the whole §3 enum table in the inventory doc) become manifest entries rather than constants scattered through handlers. A new CRM is then largely *a manifest plus auth*, which is the difference between a week and a quarter.

### 6.3 Webhook-first, reconcile-always
**CrewLogic already runs this pattern successfully** — Motive/Linxup geofence webhooks with a periodic reconcile job (`GEOFENCE_RECONCILE`). Reuse it verbatim:
- Webhooks for latency (near-real-time board).
- A periodic **reconcile sweep** that re-pulls a bounded window and repairs drift. Webhooks *will* be missed — dropped deliveries, downtime, signature failures. The 2026-07-02 Motive incident (a wrong signing secret meant every crossing 401'd, silently, while events appeared to fire) is the precedent: **a webhook path with no reconcile is a silent-failure machine.**
- Reconcile discrepancies must **log loudly**, not self-heal quietly.

### 6.4 Idempotency in both directions
- **Inbound:** every event carries a provider event id → store processed ids → drop duplicates. Providers retry; assume at-least-once delivery.
- **Outbound:** every write carries an idempotency key derived from `(entity, operation, version)`. Retrying a `create` must never produce a second job in the customer's CRM.

### 6.5 Outbox for outbound writes
Never call a provider inline from a request handler. Write intent to an `integration_outbox` row, return to the user, drain asynchronously with retry + backoff. Prevents a CRM outage from breaking CrewLogic's UI, and gives a durable audit of what was sent.

### 6.6 Explicit capability matrix + graceful degradation
Each adapter declares what it supports (`can_create_job`, `can_cancel_appointment`, `can_issue_invoice`, …). The UI reads capabilities and hides or explains what a provider cannot do. **Precedent:** Vonigo cannot cancel a single appointment on a multi-appointment job via API — that shipped as a *guard with an explanatory message*, which is exactly the right degradation shape. Generalise it.

### 6.7 Error surface discipline
Adapter errors log fully server-side (provider, operation, external id, response) and return a stable code + safe message to the client. No provider payloads, tokens, or internal ids in client responses.

---

## 7. Gap-analysis template — fill during the API spike

For each capability, answer these. **Empty cells are the gap list** — the deliverable Owner asked for.

| Question | Customers | Jobs | Invoices | Payments |
|---|---|---|---|---|
| Read supported? (endpoint, filters, pagination) | | | | |
| Write supported? (create / update / cancel) | | | | |
| Webhook/event available? (or Zapier trigger only) | | | | |
| Event latency + delivery guarantee | | | | |
| Auth model (OAuth2? API key? per-tenant app install?) | | | | |
| Rate limits | | | | |
| Idempotency support on writes | | | | |
| Version/etag field for conflict detection | | | | |
| Sandbox/test environment available? | | | | |
| Required fields we do not currently capture | | | | |
| Fields they require that have no canonical equivalent | | | | |

**Zapier note.** Owner confirmed ServiceTitan integrates via Zapier. Zapier presence implies *some* trigger (event-out) and action (write-in) surface, which is an encouraging signal for §6.3 and §5. But Zapier is **not** an acceptable production transport for this framework — it adds a third-party dependency, per-task cost, latency unsuitable for a live dispatch board, and no idempotency guarantees. Treat Zapier as **evidence that the underlying API supports these operations**, then integrate against the API directly. Worth confirming during the spike whether their Zapier triggers are webhook-backed or polling — that answers §6.3 for free.

---

## 8. Recommended sequence

1. **Approve §2** (canonical-first vs mirror-Vonigo). Gates everything — the `jobs` schema encodes this choice.
2. **Approve §4** ownership matrix. Cheap to change now, expensive after invoices exist.
3. **ServiceTitan spike** → fill §7. Timeboxed; read-only doc work.
4. **`jobs` contract** (schema + `crewlogic-jobs` API) for approval → migrations → code. Per contract-before-code.
5. Native invoicing + payment capture against `jobs` (Owner 2026-07-18: payment attaches to the JOB, never the estimate).
6. Vonigo refactored to an adapter — **last**, and only if it pays for itself. It works today; the framework must not become a rewrite of a working integration.

## 9. Open questions

- **Q-1.** Canonical-first or mirror-Vonigo? (§2) — *Lean: canonical-first, given the ServiceTitan goal.*
- **Q-2.** Ownership matrix (§4) — is "CRM owns the job, CrewLogic owns the estimate" right? Specifically: when a franchise runs ServiceTitan, should CrewLogic be able to create jobs, or only read and act on them?
- **Q-3.** Invoicing when there is **no** CRM — native `invoice_source` means CrewLogic issues and tracks invoices itself. Does that include AR (aging, reminders, statements), or issue-and-mark-paid only? *Lean: issue + mark paid for v1; AR is an accounting product.*
- **Q-4.** Does Vonigo get refactored onto the framework, or stay as-is behind the seam? *Lean: stay as-is until a second CRM proves the interface.*
- **Q-5.** Is QuickBooks an `invoice_source` candidate? A QBO integration already exists (`crewlogic-quickbooks`, super-admin/#90-internal), so the auth groundwork is partly done.

---

## 10. Follow-up actions

- [ ] Owner decision on Q-1 and Q-2 — blocks the `jobs` schema
- [ ] ServiceTitan API spike → fill §7 gap table
- [ ] Fill the ServiceTitan column in `docs/crm-integration-field-inventory.md` (it already has the empty column)
- [ ] Draft the `jobs` schema + `crewlogic-jobs` contract once Q-1/Q-2 land
