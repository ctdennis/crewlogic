-- 0073_snapshot_label_optionid.sql
--
-- Surface the Vonigo appointment LABEL (WorkOrder field 201 optionID) on the DR snapshot so the Backup
-- Schedule board can color each job to match Vonigo's own schedule colors (owner 2026-07-24). The
-- optionID already lives inside job_source_snapshot.raw (Fields[fieldID=201].optionID); this lifts it
-- into a small column the read path returns cheaply (shipping raw per row is too heavy).
--
-- optionID → name/exact-hex map lives client-side (_BS_LABEL in index.html) + memory note
-- vonigo-appointment-label-colors. e.g. 9975 Est-Converted-Job=#54AD5B, 9970 Est-Converted-EstOnly=#9596BA,
-- 245 Est-Completed-Job=#C0D587, 9996 Est-Completed-EstOnly=#B8C84D, 9984 New=#6EBFE7, 9973 Est-Only=#AA4CB3,
-- 9993 Lost=#D65136.
--
-- Additive, idempotent. Rollback at the bottom.

alter table public.job_source_snapshot add column if not exists label_optionid integer;

-- Backfill existing rows from the stored raw WorkOrder payload (field 201 optionID).
update public.job_source_snapshot s
   set label_optionid = sub.opt
  from (
    select s2.appointment_id, (f->>'optionID')::int as opt
      from public.job_source_snapshot s2
      cross join lateral jsonb_array_elements(s2.raw->'Fields') f
     where f->>'fieldID' = '201' and (f->>'optionID') ~ '^[0-9]+$'
  ) sub
 where sub.appointment_id = s.appointment_id
   and s.label_optionid is null;

comment on column public.job_source_snapshot.label_optionid is
  'Vonigo WorkOrder field 201 (appointment label) optionID — drives the Backup Schedule board color to match Vonigo. See memory note vonigo-appointment-label-colors. NULL for native/unknown.';

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- alter table public.job_source_snapshot drop column if exists label_optionid;
