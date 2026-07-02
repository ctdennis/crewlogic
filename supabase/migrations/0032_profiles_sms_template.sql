-- 0032_profiles_sms_template.sql
-- Per-USER text-message (SMS) pre-fill template. Mirrors the per-user profiles.home_card_order
-- pattern (NOT the per-franchise cost_settings blob) — each CrewLogic user sets their own text.
-- The template fills the sms: body when a user taps a "💬 Text" link (tokens: {{customer name}},
-- {{user name}}, {{company name}}). Written only via crewlogic-settings action 'saveSmsTemplate',
-- which authenticates the caller and patches only their own profiles row.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS sms_template text;

-- ROLLBACK (manual):
--   ALTER TABLE profiles DROP COLUMN IF EXISTS sms_template;
