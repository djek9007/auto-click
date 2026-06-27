#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.auto-click.pid"
ENV_FILE="$SCRIPT_DIR/.env"

# Загружаем переменные из .env если есть
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

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

# Kill any remaining instances by PID (безопаснее чем pkill -f)
for pid in $(ps axo pid,comm | grep '[n]ode' | awk '{print $1}'); do
  args=$(ps -p "$pid" -o args= 2>/dev/null)
  if echo "$args" | grep -q 'auto-click.js' && ! echo "$args" | grep -q 'pgrep'; then
    if [ "$pid" != "$(cat "$PID_FILE" 2>/dev/null)" ]; then
      echo "Останавливаю лишний процесс PID $pid..."
      kill "$pid" 2>/dev/null
    fi
  fi
done
sleep 1

> "$SCRIPT_DIR/output.log"
nohup node "$SCRIPT_DIR/auto-click.js" > "$SCRIPT_DIR/output.log" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "AutoClick запущен, PID: $NEW_PID"
