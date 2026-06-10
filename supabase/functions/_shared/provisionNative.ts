// _shared/provisionNative.ts
//
// Shared native-workspace provisioning. Creates a tenant (CRM 'none', native defaults from
// migration 0004) + franchise for a brand-new native account. Every front door that can onboard
// a native owner calls this ONE function so they stay in lockstep:
//   - crewlogic-accept-invite   (email / magic-link path)
//   - crewlogic-oauth-callback  (Google; future Microsoft/Apple reuse the same helper)
//
// Scoped to tenant+franchise only — each caller keeps its own profile-insert (the two paths build
// the profile differently). subscription_tier is left NULL so trial access is governed by the
// tenant's subscription_status default, not the paywalling 'free' tier default.
//
// Trial vs tester (opts): the DEFAULT front door is a marketing / self-serve signup →
// subscription_status='trialing' with a 14-day trial clock. Invite-provisioned workspaces (guest
// testers) pass { subscriptionStatus: 'tester', setTrialClock: false } so they get non-expiring
// access and NO countdown — by rule, only direct signups should ever be on the trial.
//
// Trial clock: a NEW trialing workspace is stamped trial_ends_at = now + TRIAL_DAYS; tester (or any
// setTrialClock=false) workspace gets trial_ends_at=NULL, same as pre-existing/grandfathered tenants
// (the client's trialState() treats NULL as "no clock"). Display only today — the client ships with
// ENFORCE_TRIAL=false, so the date drives the countdown banner but never blocks access until
// enforcement is flipped on.
//
// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const TRIAL_DAYS = 14;

export async function createNativeTenantAndFranchise(
  sb: SupabaseClient,
  companyName: string,
  opts: { subscriptionStatus?: string; setTrialClock?: boolean } = {},
): Promise<{ franchiseId: string; tenantId: string }> {
  const name = (companyName || "").trim() || "My Company";
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, 40) + "-" + crypto.randomUUID().slice(0, 8);

  // Default = trialing + 14-day clock (marketing/self-serve). Invite paths pass tester + no clock.
  const subscriptionStatus = opts.subscriptionStatus || "trialing";
  const trialEndsAt = (opts.setTrialClock === false)
    ? null
    : new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: tenant, error: tErr } = await sb.from("tenants")
    .insert({ name, slug, crm_type: "none", subscription_status: subscriptionStatus, trial_ends_at: trialEndsAt })
    .select("id")
    .single();
  if (tErr || !tenant) throw new Error("tenant_create_failed:" + (tErr?.message || "no row"));

  const { data: fr, error: fErr } = await sb.from("franchises")
    .insert({
      tenant_id: tenant.id,
      external_id: "native-" + String(tenant.id).slice(0, 8),
      franchise_name: name,
      subscription_tier: null,
    })
    .select("id")
    .single();
  if (fErr || !fr) throw new Error("franchise_create_failed:" + (fErr?.message || "no row"));

  return { franchiseId: fr.id as string, tenantId: tenant.id as string };
}
