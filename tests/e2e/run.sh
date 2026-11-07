#!/bin/bash
# Fresh stack + full UI run. Screenshots in $SHOTS (default /home/claude/e2e/shots)
cd "$(dirname "$0")/../.."
pkill -f "http.server\|test_ui.py" 2>/dev/null
bash tests/e2e/start.sh > /tmp/start.log 2>&1 || { tail -20 /tmp/start.log; exit 1; }
python3 -I tests/e2e/test_ui.py
