#!/usr/bin/env bash
# Render the real documents with production's PDF engine: the puppeteer-core version in
# package-lock.json and the Chromium pack pinned in api/_lib/pdf.ts, on Amazon Linux 2023
# (AWS's Lambda Node image, the base of Vercel's runtime), as x64. Local Chrome uses the
# operating system's fonts and versions and cannot stand in for it.
#
#   scripts/pdf-production-check/run.sh
#
# Needs Docker. Writes PDFs and screenshots of the statements to
# scripts/pdf-production-check/out/ (gitignored); look at the screenshots, a passing run
# only proves the engine renders, not that every name is legible (see issue #98).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/pdf-production-check"
PUPPETEER=$(cd "$ROOT/apps/web" && node -p "require('puppeteer-core/package.json').version")
CHROMIUM=$(grep -oE "CHROMIUM_VERSION = '[0-9.]+'" "$ROOT/apps/web/api/_lib/pdf.ts" | grep -oE "[0-9.]+")
rm -rf "$HERE/html" "$HERE/out" && mkdir -p "$HERE/html"

echo "── documents → HTML (stress names, invented)"
(cd "$ROOT/apps/web" && PDF_HTML_OUT="$HERE/html" npx vitest run test/pdf-html-export.test.ts >/dev/null)

echo "── puppeteer-core $PUPPETEER + Chromium $CHROMIUM on Amazon Linux 2023 (x64)"
cat > "$HERE/html/../package.json" <<JSON
{ "type": "module", "private": true, "dependencies": { "puppeteer-core": "$PUPPETEER", "@sparticuz/chromium-min": "$CHROMIUM" } }
JSON
MSYS_NO_PATHCONV=1 docker run --rm --platform linux/amd64 --entrypoint /bin/sh \
  -e AWS_LAMBDA_JS_RUNTIME=nodejs22.x -e HOME=/tmp -e CHROMIUM_VERSION="$CHROMIUM" \
  -v "$HERE:/work" -w /work public.ecr.aws/lambda/nodejs:22 \
  -c "npm install --silent --no-audit --no-fund >/dev/null 2>&1 && node render.mjs"
rm -rf "$HERE/node_modules" "$HERE/package.json" "$HERE/package-lock.json"
