#!/bin/sh
# Regenerates js/defaults.js from shared/settings-defaults.json (the single source
# of default texts for both the website and the app).
cd "$(dirname "$0")/.."
{ echo "// GENERATED from shared/settings-defaults.json by tools/gen-defaults.sh — do not edit."; printf "export default "; cat shared/settings-defaults.json; echo ";"; } > js/defaults.js
