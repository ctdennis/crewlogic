-- 0050_backfill_franchise_timezone.sql
--
-- Backfill cost_settings.officeTimezone from cost_settings.officeState for franchises
-- that have a state but no explicit timezone.
--
-- WHY: the app resolves a franchise's zone as
--        explicit officeTimezone  ->  STATE_TZ[officeState]  ->  'America/New_York' (default)
-- That derivation is duplicated across edge functions and the final fallback is SILENT:
-- a franchise with a blank/unmapped state resolves to Eastern and looks correct. #56
-- (Orange County, CA) ran on the Eastern default for weeks purely because officeState was
-- blank. Persisting an explicit officeTimezone makes the zone data, not a derivation, so
-- every consumer agrees and the value is inspectable.
--
-- SAFETY — this migration only FILLS BLANKS. It never overwrites an existing officeTimezone.
-- That is load-bearing, not incidental:
--   * #54 El Paso TX is explicitly 'America/Denver'. The state map gives TX ->
--     'America/Chicago' (Texas's predominant zone), which is WRONG for El Paso. Overwriting
--     would silently break their schedule board by an hour.
--   * #109 Willamette Valley OR is already 'America/Los_Angeles'.
-- Any franchise in a split state (TX, FL, TN, KY, IN, MI, ND, SD, NE, KS, OR, ID) must keep
-- its explicit value; the state map only encodes the state's PREDOMINANT zone.
--
-- Rows expected to change (verified against prod 2026-07-18):
--   #90  MA Lakeville     -> America/New_York
--   #56  CA Orange        -> America/Los_Angeles
--   #102 MI Holly         -> America/Detroit
--   #116 OH Paris         -> America/New_York
--   #36  VA Gainesville   -> America/New_York
-- Rows deliberately NOT touched:
--   #54, #109  — already explicit (see SAFETY above)
--   #28, #31   — no officeState/City/Zip at all; nothing to derive from. Their names imply
--                CT and NY (both wholly Eastern) but that is a display string, not the
--                office-state field. Left blank so the missing address data stays visible.
--
-- Idempotent: re-running is a no-op once officeTimezone is populated.

update franchises f
   set cost_settings = jsonb_set(
         coalesce(f.cost_settings, '{}'::jsonb),
         '{officeTimezone}',
         to_jsonb(m.tz)
       )
  from (values
          ('AL','America/Chicago'),              ('AK','America/Anchorage'),
          ('AZ','America/Phoenix'),              ('AR','America/Chicago'),
          ('CA','America/Los_Angeles'),          ('CO','America/Denver'),
          ('CT','America/New_York'),             ('DE','America/New_York'),
          ('DC','America/New_York'),             ('FL','America/New_York'),
          ('GA','America/New_York'),             ('HI','Pacific/Honolulu'),
          ('ID','America/Boise'),                ('IL','America/Chicago'),
          ('IN','America/Indiana/Indianapolis'), ('IA','America/Chicago'),
          ('KS','America/Chicago'),              ('KY','America/New_York'),
          ('LA','America/Chicago'),              ('ME','America/New_York'),
          ('MD','America/New_York'),             ('MA','America/New_York'),
          ('MI','America/Detroit'),              ('MN','America/Chicago'),
          ('MS','America/Chicago'),              ('MO','America/Chicago'),
          ('MT','America/Denver'),               ('NE','America/Chicago'),
          ('NV','America/Los_Angeles'),          ('NH','America/New_York'),
          ('NJ','America/New_York'),             ('NM','America/Denver'),
          ('NY','America/New_York'),             ('NC','America/New_York'),
          ('ND','America/Chicago'),              ('OH','America/New_York'),
          ('OK','America/Chicago'),              ('OR','America/Los_Angeles'),
          ('PA','America/New_York'),             ('RI','America/New_York'),
          ('SC','America/New_York'),             ('SD','America/Chicago'),
          ('TN','America/Chicago'),              ('TX','America/Chicago'),
          ('UT','America/Denver'),               ('VT','America/New_York'),
          ('VA','America/New_York'),             ('WA','America/Los_Angeles'),
          ('WV','America/New_York'),             ('WI','America/Chicago'),
          ('WY','America/Denver')
       ) as m(st, tz)
 where upper(trim(coalesce(f.cost_settings->>'officeState', ''))) = m.st
   and coalesce(nullif(trim(coalesce(f.cost_settings->>'officeTimezone', '')), ''), '') = '';
