-- 0089_pipeline_backlog_no_autoseed.sql
-- Option A (owner 2026-08-11): the FIRST pipeline sync treated the entire historical backlog as "new" and
-- auto-enrolled every item (~186) into its type's default follow-up sequence. Each first touch was +1 day, so
-- they all stacked onto one calendar day → "186 due today" on the dispatch timeline dots.
--
-- Going forward, crewlogic-pipeline guards auto-seed by RECENCY (only items whose event date is within ~3 days
-- auto-enroll), so the backlog can never be mass-dumped again. This one-time cleanup un-schedules the touches
-- that were already auto-seeded for the OLD backlog, so the timeline reflects only genuinely-recent work.
--
-- Safe: no item has been MANUALLY assigned to a sequence yet (the feature just shipped), so every scheduled
-- touch here is auto-seed. Items themselves are NOT deleted — they stay in the Pipeline list; the owner can
-- assign a sequence to any one to start deliberate follow-ups. Idempotent.
--
-- Apply: dev first (dev-sql.sh -f), then prod on promotion (prod-write-sql.sh -f — gated).

-- 1) Un-schedule (skip) the auto-seeded follow-up touches for backlog items older than the auto-seed window.
update public.pipeline_touches t
   set status = 'skipped'
  from public.pipeline_items i
 where t.pipeline_item_id = i.id
   and t.status = 'scheduled'
   and (i.occurred_at is null or i.occurred_at < now() - interval '3 days');

-- 2) Clear the sequence stamp on those backlog items so the detail modal reads Sequence = "None"
--    (they are no longer on an active cadence; the trigger keeps next_action_at in sync from the touches).
update public.pipeline_items i
   set sequence_id = null, cadence = null
 where i.sequence_id is not null
   and (i.occurred_at is null or i.occurred_at < now() - interval '3 days');

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual): there is no automatic re-seed. To re-enroll a backlog item, assign it a sequence from the
-- Pipeline UI (which re-seeds fresh touches), or temporarily widen AUTO_SEED_MAX_AGE_DAYS in crewlogic-pipeline
-- and re-sync. The skipped touches remain in pipeline_touches (status='skipped') for audit.
