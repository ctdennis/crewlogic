-- 0066_vonigo_alert_recipients.sql
--
-- Recipient list for the Vonigo up/down health alert (crewlogic-vonigo-health).
--
-- Owner directive 2026-07-23: the alert goes to ALL CrewLogic owners "conducting business in
-- Vonigo, pro level and above." Today every Vonigo owner is a beta TESTER on the 'free' tier
-- label (only #90 is 'pro'), so a strict tier filter would send to one person. Owner chose
-- "all active Vonigo owners now, with the tier gate tightening automatically once paid
-- Pro/Enterprise plans replace the tester labels."
--
-- Encoded as: owner  AND  on Vonigo  AND  has app access  AND  (tier is pro/enterprise OR a tester).
--   - Today  → all 9 Vonigo owners (all tester tenants) receive it.
--   - Later  → a converted paid Pro/Enterprise keeps receiving it; a plain free-tier signup does not.
--
-- Access model mirrors Epic A (index.html buildSessionFromSupabaseAuth): the access VALUE is the
-- franchise subscription_status if set, else the tenant subscription_status. subscription_tier is
-- the plan LABEL only — it never grants access, so it is used ONLY for the pro/enterprise gate here.
--
-- Additive only. Idempotent. Rollback at the bottom.

create or replace function public.vonigo_alert_recipients()
returns table(email text)
language sql
stable
as $$
  select distinct p.email
  from public.profiles p
  join public.franchises f on f.id = p.franchise_id
  join public.tenants   t on t.id = f.tenant_id
  where p.role = 'owner'
    and p.email is not null and p.email <> ''
    -- "conducting business in Vonigo" — submits estimates to, or prices from, Vonigo
    and (t.submission_target = 'vonigo' or t.pricing_source = 'vonigo')
    -- has working app access (franchise status authoritative if set, else tenant status)
    and coalesce(nullif(f.subscription_status, ''), t.subscription_status) in ('active','trialing','tester')
    -- pro-and-above — but current beta testers count until paid plans replace the tester labels
    and (
      f.subscription_tier in ('pro','enterprise')
      or t.subscription_status = 'tester'
      or f.subscription_status = 'tester'
    );
$$;

comment on function public.vonigo_alert_recipients() is
  'Owner emails that should receive the Vonigo up/down health alert: owner + on Vonigo + has access + (pro/enterprise tier OR tester). Read by crewlogic-vonigo-health (service role). Not exposed to clients.';

-- Owner emails are not client-readable via RPC. The health function runs as the service role
-- (bypasses these grants); anon/authenticated must not be able to enumerate owner emails.
revoke all on function public.vonigo_alert_recipients() from public;
revoke all on function public.vonigo_alert_recipients() from anon;
revoke all on function public.vonigo_alert_recipients() from authenticated;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- drop function if exists public.vonigo_alert_recipients();
