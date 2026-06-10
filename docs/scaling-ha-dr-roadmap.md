# Scaling, HA, DR & Regional Latency — Roadmap

_Created 2026-06-10. Strategy doc for how the CrewLogicAI stack scales as the subscriber base grows, and when to move up tiers. Pricing/limits are approximate and change — verify against current vendor pricing before budgeting._

## Headline

For this stack the question is **"when do we move *up* a tier"**, not **"when do we rip-and-replace."** We almost certainly **never leave Cloudflare or Resend** — we just upgrade plans. The single meaningful lever is **Supabase's tier (Free → Pro → Team → Enterprise)**, and moving up that ladder is driven by **risk / HA / compliance**, not by hitting a raw-throughput wall.

The two things most likely to actually bite first are **not** classic infra-scaling problems:
1. **Storage growth from estimate photos** (see the prod-storage-headroom note).
2. **The ~18k-line monolithic `index.html`** — a *development*-velocity and regression-risk ceiling, not a runtime one, but it slows us down long before infra does.

## Cloudflare (frontend) — never the bottleneck

Static assets on Cloudflare's global edge CDN (300+ PoPs); two Pages projects (`crewlogic` = app on `app.crewlogicai.com`, `crewlogic-marketing` = `crewlogicai.com`).
- **Scaling:** effectively infinite for static content; unlimited requests/bandwidth on free.
- **HA:** built-in, extremely resilient.
- **Regional latency:** solved by default — edge-cached worldwide.
- **Only concern:** the monolith's payload size on mobile (load time) — a code problem, not a Cloudflare one.

## Supabase — where all the real decisions live

A Supabase project = managed Postgres + Auth (GoTrue) + Storage + Edge Functions (Deno), all in **one region**.

| Dimension | Today (FREE) | How it scales |
|---|---|---|
| Throughput | tiny shared instance | **Vertical** — bump compute (Pro → add-ons to very large). Hundreds–thousands of franchises before CPU/connections wall. Supavisor pools connections. |
| HA / failover | ❌ none — single instance | **Team+** adds HA/failover + read replicas. Tier decision, not config. |
| Recovery (DR) | limited backups; free projects can pause | Pro = daily backups (~7-day). **PITR add-on** = point-in-time restore. Essential once we hold real customer data. |
| Regional latency | every PostgREST call hits the one region | US-only on `us-east` = fine (west coast ~+70ms/call, compounds because the client is chatty). International = read replicas (Team+) or rethink. |
| Storage | ~1 GB free, photo-driven | scales with plan; `crewlogic-photo-sweep` cron reclaims >30-day deleted photos. Watch headroom. |
| Edge Functions | serverless, auto-scale | fine; cold starts possible; call the DB in-region. |

**Key insight:** vertical scaling + read replicas take us very far *inside* Supabase. The forcing function to move up is **"can't afford downtime / need PITR / customer wants SOC2"**, not "ran out of capacity."

## Resend (email) — scales trivially; watch deliverability, not volume

Built on AWS SES; scales to millions.
- **Volume** grows with signups/invites/resets, not total users → modest. Free ~3k/mo (100/day) → Pro (~50k/mo) → Scale/Enterprise.
- **Real concern = deliverability:** reputation, DMARC (done 2026-06-10), dedicated IP at high volume (Scale). Also mind **Supabase Auth's own email rate-limit** setting (the actual throttle with custom SMTP).

## The "move up" ladder — by trigger, not user count

1. **First paying customer** → Supabase **Free → Pro ($25)**. Non-negotiable: free pauses, no real backups. Bump auth email rate limit. Resend free still OK.
2. **Real revenue / data we can't lose (tens of franchises)** → add **PITR**; upgrade compute if DB CPU/connections climb; Resend → Pro.
3. **Uptime matters / hundreds of franchises / first SOC2 ask** → Supabase **Team (~$599)** for HA failover + read replicas + PITR + compliance. *This is the "something more robust" — still Supabase, higher tier.*
4. **International / heavy west-coast latency** → read replicas in-region (Team+). For US-only, skip.
5. **Genuinely outgrow managed Supabase** (thousands of high-throughput tenants, bespoke infra) → self-host Postgres on RDS/Aurora + separate auth/storage. High bar; most companies never reach it.

## Risks outside the classic-scaling frame

- **Monolith (`index.html`, no build/tests):** biggest *practical* limit — team size, release safety, velocity. Plan gradual modularization + a build step.
- **n8n dependency:** remaining legacy webhooks are an external availability/scaling point. Finishing migration to Edge Functions removes a failure mode and consolidates the stack. (See the n8n inventory — verify what actually still calls it.)
- **Third-party API quotas:** Vonigo, Google Maps, Motive — rate limits/availability are external dependencies that matter at scale.

## Recommendation (near-term)

Go **Supabase Pro the moment there's a paying customer, and add PITR**. Everything else is a clean tier-up when a specific trigger fires — don't pre-build for scale we don't have. Keep watching **storage** and start chipping at the **monolith** for development scalability.
