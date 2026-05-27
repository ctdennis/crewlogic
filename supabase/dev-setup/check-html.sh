#!/usr/bin/env bash
# check-html.sh — syntax-check the largest inline <script> block in index.html (the app's
# main script) using `node --check`. No build step / no Docker. Parse-only: never executes
# the code or writes app files. Usage: bash supabase/dev-setup/check-html.sh [path]
set -euo pipefail
f="${1:-index.html}"
tmp="$(mktemp "${TMPDIR:-/tmp}/cl_mainscript.XXXXXX.js")"
trap 'rm -f "$tmp"' EXIT
python3 - "$f" "$tmp" <<'PY'
import re, sys
html = open(sys.argv[1], encoding='utf-8').read()
blocks = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.S)
open(sys.argv[2], 'w').write(max(blocks, key=len))
PY
node --check "$tmp" && echo "✅ main <script> parses clean"
