#!/usr/bin/env bash
# dev-sql.sh — run a Supabase db query ONLY against crewlogic-dev.
# Refuses if the CLI is linked to anything other than dev, so a dev-intended query
# can never reach prod. This is what lets dev SQL be auto-approved safely.
# Usage: bash supabase/dev-setup/dev-sql.sh "<sql>"   |   bash .../dev-sql.sh -f file.sql
set -euo pipefail
DEV_REF="bagkimfwmpwjfhfhmsrb"   # crewlogic-dev
linked="$(supabase projects list 2>/dev/null | grep '●' | awk -F'|' '{gsub(/[[:space:]]/,"",$3); print $3}')"
if [ "$linked" != "$DEV_REF" ]; then
  echo "REFUSED: CLI is linked to '${linked:-<none>}', not dev ($DEV_REF). Run: supabase link --project-ref $DEV_REF" >&2
  exit 1
fi
exec supabase db query --linked "$@"
