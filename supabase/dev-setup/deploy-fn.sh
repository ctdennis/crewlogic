#!/usr/bin/env bash
# deploy-fn.sh — the ONLY approved way to deploy a CrewLogic edge function.
#
# WHY THIS EXISTS: several functions are "must-be-public" — they are called by outside/headerless
# callers that do NOT send a Supabase login token (Motive/Linxup webhooks sign with their own
# signature; pg_cron jobs and server-to-server calls send no auth header at all). Those functions
# MUST be deployed with `--no-verify-jwt`, or Supabase's gateway rejects every such call with a 401
# BEFORE the function runs. A plain `supabase functions deploy` silently omits that flag.
#
# THE INCIDENT THIS PREVENTS: 2026-07-30 a deploy dropped the flag → the Motive webhook was gateway-401'd
# → geofence truck events were silently dropped FLEET-WIDE for 4+ days (unrecoverable — providers don't
# resend). Nobody noticed because the app looked fine (app calls DO send a token). See
# docs/plan-webhook-resilience.md and memory prod-edge-deploys-need-no-verify-jwt.
#
# THIS SCRIPT: forces --no-verify-jwt for every must-be-public function, and AFTER deploying a public
# function it verifies (by response BODY, not just status) that the gateway is actually open — refusing
# to report success if verify_jwt is still ON.
#
# Usage:  bash supabase/dev-setup/deploy-fn.sh <function-name> <dev|prod>
#   dev  -> project bagkimfwmpwjfhfhmsrb   prod -> project ozfkpxyachigfpcmvekz (prod is gated)

set -euo pipefail

FN="${1:?usage: deploy-fn.sh <function-name> <dev|prod>}"
ENV="${2:?usage: deploy-fn.sh <function-name> <dev|prod>}"
DEV_REF="bagkimfwmpwjfhfhmsrb"
PROD_REF="ozfkpxyachigfpcmvekz"

# MUST-BE-PUBLIC list — keep in sync with memory prod-edge-deploys-need-no-verify-jwt. If you add a new
# webhook receiver, cron target, or server-to-server-called function, ADD IT HERE.
PUBLIC=(
  crewlogic-motive-webhook
  crewlogic-linxup-webhook
  crewlogic-photo-sweep
  crewlogic-signs-lifecycle
  crewlogic-job-geofence-sync
  crewlogic-vonigo-health
  crewlogic-vonigo-sync
  crewlogic-fn-health
  crewlogic-notify
  crewlogic-vonigo-import
  crewlogic-vonigo-deep-backfill
  crewlogic-assignments
)

case "$ENV" in
  dev)  REF="$DEV_REF" ;;
  prod) REF="$PROD_REF" ;;
  *) echo "ERROR: env must be 'dev' or 'prod' (got '$ENV')"; exit 1 ;;
esac

FLAG=""
for p in "${PUBLIC[@]}"; do
  if [ "$p" = "$FN" ]; then FLAG="--no-verify-jwt"; break; fi
done

if [ -n "$FLAG" ]; then
  echo ">> $FN is MUST-BE-PUBLIC -> deploying to $ENV ($REF) with --no-verify-jwt"
else
  echo ">> $FN -> deploying to $ENV ($REF) (default gate; not in the public list)"
fi

# shellcheck disable=SC2086
supabase functions deploy --project-ref "$REF" "$FN" --use-api $FLAG

# Post-deploy gate verification for public functions — the lesson from 2026-08-03: a webhook returns
# its OWN 401 too, so judge by the BODY. A gateway-401 body names the JWT; the function's body does not.
if [ -n "$FLAG" ]; then
  echo ">> verifying the gateway is OPEN for $FN (body-based)…"
  BODY="$(curl -s -m 20 -X POST "https://$REF.supabase.co/functions/v1/$FN" -H 'Content-Type: application/json' -d '{}' || true)"
  if printf '%s' "$BODY" | grep -qiE 'invalid jwt|missing authorization|jwt is required'; then
    echo "!! FAIL: $FN still returns a GATEWAY 401 (verify_jwt is ON). Callers are being blocked."
    echo "!! body: ${BODY:0:120}"
    exit 2
  fi
  echo ">> OK: gateway open — function responded: ${BODY:0:100}"
fi

echo ">> done."
