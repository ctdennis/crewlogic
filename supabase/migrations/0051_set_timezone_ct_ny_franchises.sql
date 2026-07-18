-- 0051_set_timezone_ct_ny_franchises.sql
--
-- Set cost_settings.officeTimezone = 'America/New_York' for franchises #28 and #31.
--
-- WHY: 0050 backfilled officeTimezone from officeState, but #28 (CT - New Haven County) and
-- #31 (NY - Nassau County) have NO office address at all — officeState, officeCity and
-- officeZip are all null — so there was nothing to derive from and 0050 correctly skipped
-- them. Owner directed 2026-07-18 to set them to the same zone as #90 (America/New_York).
-- That is unambiguous: Connecticut and New York are both wholly Eastern, so unlike a split
-- state there is no wrong answer hiding behind the state name.
--
-- NOTE: this sets the TIMEZONE only. It does NOT populate the missing address
-- (officeState/City/Zip) — that gap is still open as FW-53 and is a separate decision
-- (populate vs retire the records; both currently have subscription_status = null and look
-- dormant). Setting the timezone means these two no longer depend on the SILENT Eastern
-- fallback, which is the behaviour this whole arc is removing.
--
-- SAFETY: matches on external_id and, like 0050, only fills a blank — it will not overwrite
-- an existing officeTimezone if one is set later.
--
-- Idempotent: re-running is a no-op once officeTimezone is populated.
-- Dev note: dev has neither #28 nor #31, so this is a harmless no-op there.

update franchises f
   set cost_settings = jsonb_set(
         coalesce(f.cost_settings, '{}'::jsonb),
         '{officeTimezone}',
         to_jsonb('America/New_York'::text)
       )
 where f.external_id in ('28', '31')
   and coalesce(nullif(trim(coalesce(f.cost_settings->>'officeTimezone', '')), ''), '') = '';
