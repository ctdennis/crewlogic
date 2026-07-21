-- 0064_settlement_resolution.sql
--
-- How a visit stopped being outstanding.
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────
-- 0062 made presence the signal: a visit_settlements row exists = dealt with, no row = still to
-- collect. That is still true. What it could not express is WHY a visit was dealt with.
--
-- Owner needs to clear two kinds of visit that will never receive an amount:
--   * nothing was collected and nothing is coming
--   * payment WAS taken but was never written into the spreadsheet, so the figure is lost
--
-- Both must leave the outstanding list. Neither can honestly be recorded as revenue.
--
-- ── WHY NOT JUST ENTER 0 ─────────────────────────────────────────────────────────────────
-- Because 0 already means something specific and true: "I collected nothing." Owner's own
-- history contains a real 0 and a real -80 (the recycler charged them). Overloading 0 to also
-- mean "closed, amount unknown" would:
--   * inflate collectedVisits with visits that were never priced
--   * drag the average $/visit toward zero
--   * UNDERSTATE real revenue in the paid-but-unrecorded case — money genuinely came in
-- and, worst of all, it would be unrecoverable: nothing in the row would distinguish a true
-- zero from a write-off, so the mistake could never be unwound later.
--
-- So closure is recorded as its OWN state and reported separately. The revenue total stays
-- honest about what it does and does not know.
--
-- ── DEFAULT IS 'collected' ───────────────────────────────────────────────────────────────
-- Every row that exists today was created by entering an amount, so 'collected' is the truth
-- for all of them and the backfill is a no-op in practice. Existing totals cannot shift.
--
-- Additive only. Idempotent. Rollback at the bottom.

alter table public.visit_settlements
  add column if not exists resolution text not null default 'collected';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'visit_settlements_resolution_chk'
  ) then
    alter table public.visit_settlements
      add constraint visit_settlements_resolution_chk
      check (resolution in ('collected', 'closed'));
  end if;
end $$;

-- Reporting splits on this, and the outstanding view is "no row at all", so the index pairs it
-- with franchise + settled_at the same way the collected-over-time query reads.
create index if not exists visit_settlements_resolution_idx
  on public.visit_settlements (franchise_id, resolution, settled_at desc);

comment on column public.visit_settlements.resolution is
  'How the visit left the outstanding list. collected = a real amount was received (amount is money, 0 and negatives are valid). closed = cleared WITHOUT a known amount (nothing collected, or payment taken but never recorded); amount is meaningless and MUST be excluded from revenue totals. Closed visits are reported as their own count so written-off money stays visible rather than reading as $0 revenue.';

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- alter table public.visit_settlements drop constraint if exists visit_settlements_resolution_chk;
-- drop index if exists public.visit_settlements_resolution_idx;
-- alter table public.visit_settlements drop column if exists resolution;
