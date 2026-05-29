#!/usr/bin/env bash
# prod-readonly-sql.sh — run a STRICTLY READ-ONLY query against crewlogic-PROD.
#
# Safe to auto-approve because writes are blocked TWO independent ways:
#   1. Static guard: the SQL must begin with a read verb (SELECT/WITH/EXPLAIN/SHOW/
#      TABLE/VALUES) and must not contain any write / DDL / transaction-control keyword.
#   2. DB-enforced: the query runs inside `BEGIN TRANSACTION READ ONLY; … ; ROLLBACK;`,
#      so PostgreSQL itself rejects any INSERT/UPDATE/DELETE/DDL ("cannot execute … in a
#      read-only transaction") even if something slipped past the static guard.
# It also refuses unless the CLI is linked to PROD, so a query can't silently hit the
# wrong project. This is the prod counterpart to dev-sql.sh.
#
# Usage: bash supabase/dev-setup/prod-readonly-sql.sh "SELECT ... FROM ... WHERE ..."
set -euo pipefail
PROD_REF="ozfkpxyachigfpcmvekz"   # crewlogic-prod

if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
  echo "Usage: bash supabase/dev-setup/prod-readonly-sql.sh \"<SELECT ...>\"" >&2
  exit 2
fi
SQL="$1"

# --- Gate: must be linked to prod -------------------------------------------
linked="$(supabase projects list 2>/dev/null | grep '●' | awk -F'|' '{gsub(/[[:space:]]/,"",$3); print $3}')"
if [ "$linked" != "$PROD_REF" ]; then
  echo "REFUSED: CLI is linked to '${linked:-<none>}', not prod ($PROD_REF). Run: supabase link --project-ref $PROD_REF" >&2
  exit 1
fi

# --- Layer 1: static guard --------------------------------------------------
# Must start with a read verb (after trimming leading whitespace).
stripped="$(printf '%s' "$SQL" | sed -E 's/^[[:space:]]+//')"
if ! printf '%s' "$stripped" | grep -qiE '^(select|with|explain|show|table|values)[[:space:](]'; then
  echo "REFUSED: query must begin with SELECT / WITH / EXPLAIN / SHOW / TABLE / VALUES (read-only only)." >&2
  exit 1
fi
# Reject write / DDL / transaction-control / privilege keywords (whole word, case-insensitive).
# Transaction-control words (begin/commit/rollback/start/savepoint/set/reset) are blocked so
# the query cannot break OUT of the read-only transaction added in Layer 2.
if printf '%s' "$SQL" | grep -qiwE 'insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|do|vacuum|reindex|cluster|refresh|lock|comment|begin|commit|rollback|start|savepoint|set|reset|prepare|execute|listen|notify'; then
  echo "REFUSED: query contains a write / DDL / transaction-control keyword — read-only SELECTs only." >&2
  exit 1
fi

# --- Layer 2: DB-enforced read-only transaction -----------------------------
# Strip a trailing semicolon so we control statement framing.
clean="$(printf '%s' "$SQL" | sed -E 's/;[[:space:]]*$//')"
exec supabase db query --linked "BEGIN TRANSACTION READ ONLY; ${clean}; ROLLBACK;"
