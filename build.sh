#!/usr/bin/env bash
# Cloudflare Pages build step — assemble ONLY the public static site into dist/.
set -euo pipefail

rm -rf dist
mkdir -p dist

cp index.html dist/
cp -r assets dist/

echo "build: dist/ assembled with $(find dist -type f | wc -l) files"