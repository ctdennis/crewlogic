#!/usr/bin/env bash
# prod-write-sql.sh — run a WRITE / DDL statement against crewlogic-PROD (migrations, approved fixes).
#
# Replaces the raw `supabase link prod → db query --linked → link dev` dance, which was easy to leave
# half-done (link left on prod). This bundles all three so the re-link to dev CAN'T be forgotten:
#   1. auto-link to PROD
#   2. run the statement
#   3. ALWAYS re-link to DEV (the safe resting state) — even if the statement fails
#
# GATE: this is deliberately NOT in the allowlist, so every run prompts for approval — that's the
# human gate for a prod mutation. Use ONLY for approved prod schema changes.
#
# Usage: bash supabase/dev-setup/prod-write-sql.sh "<sql>"
#    or: bash supabase/dev-setup/prod-write-sql.sh -f supabase/migrations/NNNN_*.sql
set -euo pipefail
PROD_REF="ozfkpxyachigfpcmvekz"   # crewlogic-prod
DEV_REF="bagkimfwmpwjfhfhmsrb"    # crewlogic-dev (safe resting state)

if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
  echo "Usage: bash supabase/dev-setup/prod-write-sql.sh \"<sql>\"" >&2
  exit 2
fi

echo "[prod-write] linking to prod ($PROD_REF) + running write…" >&2
supabase link --project-ref "$PROD_REF" >/dev/null 2>&1 || { echo "ERROR: could not link to prod ($PROD_REF)." >&2; exit 1; }
set +e
supabase db query --linked "$@"   # forward all args so both "<sql>" and -f file.sql work
rc=$?
set -e
supabase link --project-ref "$DEV_REF" >/dev/null 2>&1 || true   # ALWAYS return to the dev resting state
echo "[prod-write] done (rc=$rc); CLI re-linked to dev." >&2
exit $rc
