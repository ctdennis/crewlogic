#!/usr/bin/env bash
# prod-readonly-sql.sh — run a STRICTLY READ-ONLY query against crewlogic-PROD.
#
# Safe to auto-approve because writes are blocked TWO independent ways:
#   1. Static guard: the SQL must begin with a read verb (SELECT/WITH/EXPLAIN/SHOW/
#      TABLE/VALUES) and must not contain any write / DDL / transaction-control keyword.
#   2. DB-enforced: the query runs inside `BEGIN TRANSACTION READ ONLY; … ; ROLLBACK;`,
#      so PostgreSQL itself rejects any INSERT/UPDATE/DELETE/DDL even if something slipped past.
#
# SELF-TARGETING (2026-07-25): the static guards run FIRST (a bad query fails without touching the
# link). Then it auto-links to prod, runs the read, and ALWAYS re-links back to dev — so I never
# hand-run `supabase link`, and the CLI's resting state is always dev (never left on prod).
#
# Usage: bash supabase/dev-setup/prod-readonly-sql.sh "SELECT ... FROM ... WHERE ..."
set -euo pipefail
PROD_REF="ozfkpxyachigfpcmvekz"   # crewlogic-prod
DEV_REF="bagkimfwmpwjfhfhmsrb"    # crewlogic-dev (safe resting state)

if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
  echo "Usage: bash supabase/dev-setup/prod-readonly-sql.sh \"<SELECT ...>\"" >&2
  exit 2
fi
SQL="$1"

# --- Layer 1: static guard (FIRST — a bad query fails before we touch the link) ----------
stripped="$(printf '%s' "$SQL" | sed -E 's/^[[:space:]]+//')"
if ! printf '%s' "$stripped" | grep -qiE '^(select|with|explain|show|table|values)[[:space:](]'; then
  echo "REFUSED: query must begin with SELECT / WITH / EXPLAIN / SHOW / TABLE / VALUES (read-only only)." >&2
  exit 1
fi
if printf '%s' "$SQL" | grep -qiwE 'insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|do|vacuum|reindex|cluster|refresh|lock|comment|begin|commit|rollback|start|savepoint|set|reset|prepare|execute|listen|notify'; then
  echo "REFUSED: query contains a write / DDL / transaction-control keyword — read-only SELECTs only." >&2
  exit 1
fi

# --- Self-target: ensure the CLI is linked to prod (auto-link if not) --------------------
linked="$(supabase projects list 2>/dev/null | grep '●' | awk -F'|' '{gsub(/[[:space:]]/,"",$3); print $3}')"
if [ "$linked" != "$PROD_REF" ]; then
  echo "[prod-readonly] linking CLI to prod ($PROD_REF)…" >&2
  supabase link --project-ref "$PROD_REF" >/dev/null 2>&1 || { echo "REFUSED: could not link to prod ($PROD_REF)." >&2; exit 1; }
fi

# --- Layer 2: DB-enforced read-only transaction, then ALWAYS return to dev ----------------
clean="$(printf '%s' "$SQL" | sed -E 's/;[[:space:]]*$//')"
set +e
supabase db query --linked "BEGIN TRANSACTION READ ONLY; ${clean}; ROLLBACK;"
rc=$?
set -e
supabase link --project-ref "$DEV_REF" >/dev/null 2>&1 || true   # resting state = dev, never left on prod
exit $rc
