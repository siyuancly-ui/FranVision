#!/usr/bin/env bash
# Manual deploy of the Feature Sheet Builder to Cloudflare (the `franvision`
# Worker). Use this whenever the GitHub -> Cloudflare auto-build is not firing.
#
#   one-time:   npx wrangler login
#   each time:  bash deploy.sh
#
# It regenerates the git-ignored public/shared + public/template-assets, then
# uploads feature-sheet-builder/public/ as the assets-only Worker per
# wrangler.jsonc (name: franvision).
set -euo pipefail
cd "$(dirname "$0")"
node feature-sheet-builder/prepare-static.js
npx wrangler deploy
