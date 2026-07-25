#!/usr/bin/env bash
# dev-sql.sh — run a Supabase db query against crewlogic-dev.
#
# SELF-TARGETING (2026-07-25): if the CLI isn't already linked to dev, this auto-links to dev before
# running, so a dev-intended query ALWAYS hits dev regardless of the prior link state — no manual
# `supabase link` needed. dev is the safe resting state, so we leave the link on dev afterward. This is
# what lets dev SQL be auto-approved safely (a dev query can never reach prod).
#
# Usage: bash supabase/dev-setup/dev-sql.sh "<sql>"   |   bash .../dev-sql.sh -f file.sql
set -euo pipefail
DEV_REF="bagkimfwmpwjfhfhmsrb"   # crewlogic-dev
linked="$(supabase projects list 2>/dev/null | grep '●' | awk -F'|' '{gsub(/[[:space:]]/,"",$3); print $3}')"
if [ "$linked" != "$DEV_REF" ]; then
  echo "[dev-sql] linking CLI to dev ($DEV_REF)…" >&2
  supabase link --project-ref "$DEV_REF" >/dev/null 2>&1 || { echo "REFUSED: could not link to dev ($DEV_REF)." >&2; exit 1; }
fi
exec supabase db query --linked "$@"
