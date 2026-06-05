# Plan — Normalize estimate charges (out of the JSON blob, into tables)

**Status:** In progress — **Phases 1–2 done on dev** (2026-06-05). Owner-approved. Move line items from the `payload` JSON blob into a real relational table, to permanently end the class of bug where a partial/stale save blanks an estimate.

> **Implemented design (simpler than the illustrative schema in §2 below):** ONE table, `estimate_charges`, one row per charge. Each row stores the **complete original charge object** in a `data jsonb` column (lossless — the frontend gets back exactly what it wrote: `photos[]`, Vonigo `priceItemID`/`taxID`, AI analysis, etc.) **plus promoted columns** for reporting/indexing (`type, area, room, name, description, qty, unit_price, truck_volume, sequence`). **No separate photos table** — photo paths stay inside each charge's `data` (the Storage files are unchanged). Source of truth = migration **`0012_estimate_charges.sql`**; backfill = **`0013_backfill_estimate_charges.sql`**.
>
> **Dev progress:** 0012 (table + franchise-scoped RLS mirroring `estimates`) and 0013 (backfill) applied to dev. Verified: 38 charge rows = 38 blob charges, **0 estimates mismatched**.

> **Braces already shipped (v5.26.1 / v5.26.2)** keep the *current* app safe while this happens — they are stop-gaps, not the fix:
> - status changes (Won/Lost/Reopen) now PATCH only the `status` column (never re-save the body);
> - the `crewlogic-estimate` save **refuses** any payload with no `charges` array when the stored row has line items (server-side, protects old clients too);
> - an empty/failed estimates list shows "couldn't load — sign in" and **no longer overwrites the local cache** with empty.

---

## 1. Problem

Each estimate is one row in `estimates`, and the **line items live inside the `payload` JSONB blob** (`payload.charges[]`). Several code paths read the whole blob, mutate it in memory, and **write the whole blob back**. Any path that does this while holding an incomplete copy silently overwrites everything else. That's how a status toggle wiped ~15 estimates' charges.

A blob can be made safe (always full read-modify-write), but the relational model makes the safe behavior the **default** — a status update literally cannot touch a separate `estimate_charges` table — and unlocks reporting the blob can't do (won/lost by item, volume by area, conversion by ZIP, etc.).

## 2. Target data model

Keep `estimates` as the **header** (it's already mostly columns: status, client, address, totals, vonigo IDs, cover photo, timestamps). Move line items out:

```sql
-- One row per line item on an estimate.
create table public.estimate_charges (
  id            uuid primary key default gen_random_uuid(),
  estimate_id   bigint not null references public.estimates(estimate_id) on delete cascade,
  franchise_id  uuid   not null references public.franchises(id),   -- for RLS scoping (mirrors estimates)
  sequence      int    not null default 0,                          -- display order
  area          text,                                               -- e.g. "Garage"
  room          text,
  item_name     text,                                               -- the priced item / description
  description   text,
  quantity      numeric,
  unit          text,
  volume        numeric,
  price         numeric,
  meta          jsonb  not null default '{}',                       -- catch-all for fields we don't promote yet
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on public.estimate_charges (estimate_id, sequence);

-- One row per photo on a charge. (Files already live in Storage; this is just the reference + order.)
create table public.estimate_charge_photos (
  id           uuid primary key default gen_random_uuid(),
  charge_id    uuid not null references public.estimate_charges(id) on delete cascade,
  franchise_id uuid not null references public.franchises(id),
  storage_path text not null,                                       -- e.g. "90/<est>/<ts>_room_0.jpg"
  sequence     int  not null default 0,
  created_at   timestamptz not null default now()
);
```

- **RLS:** `estimate_charges` / `estimate_charge_photos` get the same franchise-scoped policies as `estimates` (migrations 0006–0010 pattern). `ON DELETE CASCADE` keeps them tidy when an estimate or charge is removed.
- Snapshot semantics are preserved: charges are **copies** (their own price/qty), not FKs to price lists — exactly as today, so past estimates still keep their saved prices.

## 3. Phased rollout (each phase is independently shippable, verifiable, reversible)

- **Phase 0 — Braces.** ✅ Done (v5.26.1/.2). The app can't lose charges in the meantime.
- **Phase 1 — Schema.** ✅ **Done on dev** — `0012_estimate_charges.sql` (table + franchise-scoped RLS). No behavior change. (Prod apply gated, at cut-over.)
- **Phase 2 — Backfill.** ✅ **Done on dev** — `0013_backfill_estimate_charges.sql` (idempotent: rebuild rows from `payload.charges[]`). Verified 38=38, 0 mismatches. (Prod apply gated, once, right before dual-write.)
- **Phase 3 — Dual-write.** ✅ **Done on dev** — `crewlogic-estimate` save best-effort mirrors charges into `estimate_charges` (delete-then-insert, after the estimates upsert; failures logged, never block the save). Deployed to dev + tested (save→2 rows, re-save with 1→replaced cleanly, delete estimate→cascade). Reads still use the blob → zero user-visible risk. (Prod deploy gated, coordinated with the 0012/0013 prod apply.)
- **Phase 4 — Cut over reads.** `openEstimate` + the renderers read charges from the tables (JOIN) instead of the blob. Dual-write stays on as a safety net. This is the phase that retires the blob fragility.
- **Phase 5 — Retire blob charges.** Stop writing `charges` into the blob (optionally keep a small denormalized snapshot for the PDF/Vonigo submit if convenient). Remove blob-charge dependencies.

A problem in any phase → stop and roll back that phase; earlier phases keep working.

## 4. Code touch-points (the real work is here)

- **Frontend (`index.html`):** `openEstimate` (load), `saveEstimateDraft` / autosave (write per-charge upsert/delete instead of blob), `renderCharges` and the charge editors, photo handling, the local cache model (`cl_estimates_local`) and offline autosave.
- **Edge function (`crewlogic-estimate`):** `save` writes charges to the tables; `submitQuote` (Vonigo) reads charges from the tables; keep the charge-wipe guard.
- **PDF generation:** reads charges from the new source.
- **Deleted-photo sweep / cover logic:** unaffected (Storage unchanged), but photo references move to `estimate_charge_photos`.

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Offline/local autosave model is blob-centric | Keep the local cache as-is through Phase 4; only change the *server* read/write. Revisit local model last. |
| Vonigo submit / PDF read charges | Update both in Phase 4; dual-write means the blob still works as a fallback during transition. |
| Backfill misses odd legacy shapes | `meta jsonb` catch-all + a verification pass (counts + spot-checks) before Phase 4. |
| Concurrent edits | Per-charge rows make this *better* than the blob, not worse. |

## 6. Effort & sequencing

Realistically **~1–3 weeks** of deliberate work, dominated by Phase 4 (rewiring read/write paths through an 18k-line single file) and testing. Phases 1–3 are low-risk and fast; they can land first so the tables exist and stay in sync long before we flip reads.

## 7. Out of scope (for now)

- A full relational refactor of `price_book` / `cost_analysis` blobs (separate, lower-risk — they aren't the data-loss vector).
- Changing the offline-first local model (revisit after Phase 4).
