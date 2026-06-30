#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.auto-click.pid"
ENV_FILE="$SCRIPT_DIR/.env"

# Проверяем наличие .env файла
if [ ! -f "$ENV_FILE" ]; then
  echo ""
  echo "╔══════════════════════════════════════════╗"
  echo "║  ❌ Файл .env не найден!                ║"
  echo "╚══════════════════════════════════════════╝"
  echo ""
  echo "Создайте его из шаблона:"
  echo "  cp .env.example .env"
  echo ""
  echo "Или создайте вручную с содержимым:"
  echo "  EMAIL=ваш@email.com"
  echo "  PASSWORD=ваш_пароль"
  echo "  TELEGRAM_TOKEN=токен_бота"
  echo ""
  exit 1
fi

# Проверяем что переменные заданы
set -a
source "$ENV_FILE"
set +a

if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ] || [ -z "$TELEGRAM_TOKEN" ]; then
  echo ""
  echo "╔══════════════════════════════════════════╗"
  echo "║  ❌ Не все переменные заданы в .env!     ║"
  echo "╚══════════════════════════════════════════╝"
  echo ""
  echo "Обязательные переменные:"
  [ -z "$EMAIL" ] && echo "  ❌ EMAIL — не задан"
  [ -z "$PASSWORD" ] && echo "  ❌ PASSWORD — не задан"
  [ -z "$TELEGRAM_TOKEN" ] && echo "  ❌ TELEGRAM_TOKEN — не задан"
  echo ""
  exit 1
fi

echo "✅ Конфигурация загружена: $EMAIL"

# Kill by PID file first (most reliable)
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Останавливаю старый процесс PID $OLD_PID..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
  rm -f "$PID_FILE"
fi

# Kill any remaining instances by PID (безопаснее чем pkill -f)
for pid in $(ps axo pid,comm | grep '[n]ode' | awk '{print $1}' || true); do
  args=$(ps -p "$pid" -o args= 2>/dev/null)
  if echo "$args" | grep -q 'auto-click.js' && ! echo "$args" | grep -q 'pgrep'; then
    if [ "$pid" != "$OLD_PID" ]; then
      echo "Останавливаю лишний процесс PID $pid..."
      kill "$pid" 2>/dev/null || true
    fi
  fi
done
sleep 1

# Rotate log if > 5MB
if [ -f "$SCRIPT_DIR/output.log" ]; then
  LOG_SIZE=$(wc -c < "$SCRIPT_DIR/output.log" 2>/dev/null || echo 0)
  if [ "$LOG_SIZE" -gt 5242880 ]; then
    mv "$SCRIPT_DIR/output.log" "$SCRIPT_DIR/output.log.1"
  fi
fi

# Установка зависимостей если нужно
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "📦 Установка зависимостей (npm install)..."
  cd "$SCRIPT_DIR" && npm install --no-fund --no-audit 2>&1 | tail -3
fi

nohup node "$SCRIPT_DIR/auto-click.js" > "$SCRIPT_DIR/output.log" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "AutoClick запущен, PID: $NEW_PID"
