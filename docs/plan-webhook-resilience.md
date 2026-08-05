# Webhook Resilience — RCA + Prevention Plan

**Incident:** Motive/Linxup geofence webhook events silently dropped **fleet-wide for 4+ days**
(2026-07-30 → 2026-08-03). Discovered by the owner when a Saturday transfer-station stop wasn't
recorded and couldn't be billed. Dropped webhook events are **unrecoverable** (providers don't resend).

---

## What happened (plain English)

Every CrewLogic background service runs behind a Supabase security gate. A deploy flag —
`--no-verify-jwt` — tells the gate "let outside callers through; they prove themselves their own way"
(Motive/Linxup sign requests with a signature; pg_cron sends no auth header at all).

1. **2026-07-30:** a routine edge-function deploy went out **without that flag**, flipping the gate to
   "logged-in callers only" for the webhooks and several cron jobs.
2. From then on, Supabase's gate **rejected every Motive/Linxup post with a 401 before our code saw it.**
3. After days of rejections, **Motive parked the webhook connection** (standard provider behavior after
   sustained failures) — so even re-opening the gate later didn't resume delivery; a full
   delete-and-recreate of the Motive webhook was required.
4. **Nobody noticed for 4 days** because (a) nothing was monitoring it, and (b) the app looked fine — app
   calls carry a login token, so they were never blocked. Only the "doorbell for outside callers" broke.

## Root causes

1. **A critical setting depended on a human remembering a flag.** A plain `supabase functions deploy`
   silently omits `--no-verify-jwt`. Manual discipline failed.
2. **No monitoring on silent background services.** The only symptom was missing revenue days later.
3. **The failure was invisible** — the app was fully functional, masking the broken webhook.
4. **Diagnosis was slow** (the recovery afternoon): a `401` is ambiguous (the *gateway* rejecting vs the
   *webhook's own* "missing signature" — both return 401), there was no logging/capture surface in
   production, and a diagnostic table existed only in dev. All of this cost hours.

## Preventive measures

### 1. Deploy guardrail — DONE (this change) — the #1 fix
`supabase/dev-setup/deploy-fn.sh` is now the ONLY approved deploy path. It holds the must-be-public list
and **forces `--no-verify-jwt`** for those functions, then **verifies (by response body, not status
code) that the gate is actually open** after deploying — refusing to report success if verify_jwt is
still on. A dropped flag can no longer ship silently. CLAUDE.md now mandates this script.
Usage: `bash supabase/dev-setup/deploy-fn.sh <fn> <dev|prod>`.

### 2. Monitoring — DONE (2026-08-03) — the backstop
`crewlogic-fn-health` (pg_cron every 10 min) probes the webhooks and, on a healthy→blocked transition,
emails the owner with the impact + the exact fix command. "Discovered 4 days later" becomes "alerted in
~10 minutes." Body-based detection distinguishes a real gateway-401 from a webhook's own 401.

### 3. Faster diagnosis — DONE / IN PLACE
- The correct verification method (check the **body**, not the status) is documented in the deploy
  script, in memory (`prod-edge-deploys-need-no-verify-jwt`), and enforced by the guardrail's post-deploy check.
- A `motive_webhook_capture` table now exists in **production** (it was dev-only), so incoming webhook
  requests can be inspected live during a future incident.

## Open follow-ups (secondary)

- **Extend the monitor to the cron functions** (photo-sweep, signs-lifecycle, job-geofence-sync, etc.).
  They can't be safely probed by an unsigned POST (it would execute them), so each needs a
  `{healthPing:true}` early-return first, then add them to `crewlogic-fn-health`.
- **Outcome-based alert:** "no geofence events received during business hours for N hours → alert" — a
  second signal that catches provider-side parking (like Motive giving up) even when the gate is open.
- **Remove the temporary capture instrumentation** from `crewlogic-motive-webhook` once the current #90
  secret re-sync is confirmed.

## Status
Root cause fixed (gate re-opened, Motive webhook recreated). Prevention: guardrail + monitor live.
The residual gap (bypassing the script with a raw deploy) is caught by the monitor within ~10 min.
