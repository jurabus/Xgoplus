#!/bin/sh
# Rebuilds js/vendor/*.js (run from repo root). Libraries are bundled, never loaded from a CDN.
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm i --no-save esbuild @supabase/supabase-js qrcode-generator jsqr
for f in supabase qrgen qrscan; do
  npx esbuild "$f.js" --bundle --format=esm --minify --target=es2020 --outfile="../../js/vendor/$f.js"
done
