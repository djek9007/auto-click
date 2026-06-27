#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.auto-click.pid"

# Kill by PID file first (most reliable)
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Останавливаю старый процесс PID $OLD_PID..."
    kill "$OLD_PID" 2>/dev/null
    sleep 2
  fi
  rm -f "$PID_FILE"
fi

# Kill any remaining instances by name (safety net)
pkill -f "node.*auto-click.js" 2>/dev/null
sleep 1

> "$SCRIPT_DIR/output.log"
nohup node "$SCRIPT_DIR/auto-click.js" > "$SCRIPT_DIR/output.log" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "AutoClick запущен, PID: $NEW_PID"
