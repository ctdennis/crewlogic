-- 0075_usage_ai_calls_dimension.sql
-- Split the mislabeled single "estimates" meter into three honest dimensions:
--   estimates = distinct saved estimates (advisory — never blocks)
--   ai_calls  = per-room AI analyses + volume checks — the Anthropic cost unit (enforced)
--   photos    = images analyzed (enforced)
-- Adds the AI-calls cap to tier_limits + a per-franchise one-time AI-calls overage credit
-- (mirrors overage_est_credit / overage_photo_credit). Numbers are DB-tunable
-- (pricing-never-in-code); hard enforcement stays gated OFF (ENFORCE_USAGE_CAPS) until flipped.

alter table tier_limits add column if not exists included_ai_calls integer;

-- Seed: AI calls = 3 x the distinct-estimate allowance (Owner 2026-07-27; Starter 25 est -> 75 calls).
update tier_limits set included_ai_calls = 75  where tier = 'starter';
update tier_limits set included_ai_calls = 225 where tier = 'pro';
update tier_limits set included_ai_calls = 750 where tier = 'enterprise';

-- Per-franchise one-time AI-call overage credit (parallels overage_est_credit / overage_photo_credit).
alter table franchises add column if not exists overage_call_credit integer not null default 0;
