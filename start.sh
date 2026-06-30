#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── Автоматическая установка в /Users/Shared/ (macOS Guest Account) ───
PERSISTENT_DIR="/Users/Shared/.auto-click"
PLIST_PATH="$HOME/Library/LaunchAgents/com.autoclick.plist"

if [ "$(uname -s)" = "Darwin" ]; then
  if [ "$SCRIPT_DIR" = "$PERSISTENT_DIR" ]; then
    echo "✅ Запуск из $PERSISTENT_DIR"
  elif [ -d "$PERSISTENT_DIR" ]; then
    echo "📂 Переход в $PERSISTENT_DIR..."
    if [ "$SCRIPT_DIR" != "/" ] && [ "$SCRIPT_DIR" != "$PERSISTENT_DIR" ] && [ "$SCRIPT_DIR" != "/Users/Shared" ]; then
      echo "🗑  Удаление: $SCRIPT_DIR"
      rm -rf "$SCRIPT_DIR"
    fi
    exec bash "$PERSISTENT_DIR/start.sh" "$@"
  else
    echo ""
    echo "╔══════════════════════════════════════════════════╗"
    echo "║  🔄 Первый запуск — установка                   ║"
    echo "╚══════════════════════════════════════════════════╝"
    echo ""

    if [ ! -f "$SCRIPT_DIR/.env" ]; then
      echo "❌ Файл .env не найден в $SCRIPT_DIR"
      exit 1
    fi

    set -a
    source "$SCRIPT_DIR/.env"
    set +a

    if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ] || [ -z "$TELEGRAM_TOKEN" ]; then
      if [ -z "$CONFIG_GIST_ID" ]; then
        echo "❌ Не все переменные заданы в .env!"
        exit 1
      fi
    fi

    echo "📁 Копирование в $PERSISTENT_DIR ..."
    mkdir -p "$PERSISTENT_DIR"
    rsync -a --exclude='node_modules' --exclude='output.log' --exclude='output.log.1' "$SCRIPT_DIR/" "$PERSISTENT_DIR/"
    [ ! -f "$PERSISTENT_DIR/.env" ] && cp "$SCRIPT_DIR/.env" "$PERSISTENT_DIR/.env"

    echo "📦 Установка зависимостей..."
    cd "$PERSISTENT_DIR" && npm install --no-fund --no-audit 2>&1 | tail -3

    echo "🌐 Скачивание Chrome..."
    cd "$PERSISTENT_DIR" && npx puppeteer browsers install chrome 2>&1 | tail -3

    echo "✅ Установка завершена!"

    if [ "$SCRIPT_DIR" != "/" ] && [ "$SCRIPT_DIR" != "$PERSISTENT_DIR" ]; then
      echo "🗑  Удаление: $SCRIPT_DIR"
      rm -rf "$SCRIPT_DIR"
    fi

    exec bash "$PERSISTENT_DIR/start.sh" "$@"
  fi
fi

# ─── Основная логика запуска ──────────────────────────────────────────
PID_FILE="$SCRIPT_DIR/.auto-click.pid"
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Файл .env не найден в $SCRIPT_DIR"
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ] || [ -z "$TELEGRAM_TOKEN" ]; then
  if [ -z "$CONFIG_GIST_ID" ]; then
    echo "❌ Не все переменные заданы в .env!"
    exit 1
  fi
fi

echo "✅ Конфигурация: $EMAIL"
echo "📁 Директория: $SCRIPT_DIR"

# Убираем ВСЕ старые процессы auto-click
for pid in $(ps axo pid,comm | grep '[n]ode' | awk '{print $1}' || true); do
  args=$(ps -p "$pid" -o args= 2>/dev/null || true)
  if echo "$args" | grep -q 'auto-click.js'; then
    echo "Останавливаю PID $pid..."
    kill "$pid" 2>/dev/null || true
  fi
done
sleep 1
for pid in $(ps axo pid,comm | grep '[n]ode' | awk '{print $1}' || true); do
  args=$(ps -p "$pid" -o args= 2>/dev/null || true)
  if echo "$args" | grep -q 'auto-click.js'; then
    kill -9 "$pid" 2>/dev/null || true
  fi
done

rm -f "$PID_FILE"

# ─── Проверка DNS для GitHub ───
if ! host github.com >/dev/null 2>&1 && ! nslookup github.com >/dev/null 2>&1; then
  echo "⚠️  github.com не резолвится — исправление DNS..."
  GITHUB_IP="140.82.121.3"
  # Пробуем добавить в /etc/hosts (нужен sudo)
  if grep -q "$GITHUB_IP.*github.com" /etc/hosts 2>/dev/null; then
    echo "✅ github.com уже в /etc/hosts"
  elif sudo bash -c "echo '$GITHUB_IP github.com github.global.ssl.fastly.net' >> /etc/hosts" 2>/dev/null; then
    echo "✅ github.com добавлен в /etc/hosts"
  else
    echo "❌ Не удалось добавить в /etc/hosts (нет sudo)"
    echo "   Выполните вручную:"
    echo "   echo '$GITHUB_IP github.com' | sudo tee -a /etc/hosts"
  fi
fi

# Ротация лога > 5MB
if [ -f "$SCRIPT_DIR/output.log" ]; then
  LOG_SIZE=$(wc -c < "$SCRIPT_DIR/output.log" 2>/dev/null || echo 0)
  if [ "$LOG_SIZE" -gt 5242880 ]; then
    mv "$SCRIPT_DIR/output.log" "$SCRIPT_DIR/output.log.1"
  fi
fi

# Установка зависимостей если нужно
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "📦 Установка зависимостей..."
  cd "$SCRIPT_DIR" && npm install --no-fund --no-audit 2>&1 | tail -3
fi

# Проверка Chrome — ищем именно бинарник, а не просто папку
CHROME_BIN=$(find "$SCRIPT_DIR/node_modules/.cache/puppeteer" -name "Chromium" -type f 2>/dev/null | head -1)
if [ -z "$CHROME_BIN" ]; then
  echo "🌐 Установка Chrome для Puppeteer..."
  cd "$SCRIPT_DIR" && npx puppeteer browsers install chrome 2>&1 | tail -3
  # Проверяем снова
  CHROME_BIN=$(find "$SCRIPT_DIR/node_modules/.cache/puppeteer" -name "Chromium" -type f 2>/dev/null | head -1)
  if [ -z "$CHROME_BIN" ]; then
    echo "⚠️  Chrome не найден после установки!"
  else
    echo "✅ Chrome установлен: $CHROME_BIN"
  fi
else
  echo "✅ Chrome найден: $CHROME_BIN"
fi

# ─── Автозапуск — ВСЕГДА пересоздаём LaunchAgent ───
if [ "$(uname -s)" = "Darwin" ]; then
  echo "⚙️ Настройка автозапуска..."
  mkdir -p "$HOME/Library/LaunchAgents"

  # Удаляем старый LaunchAgent если есть
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"

  cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.autoclick</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${PERSISTENT_DIR}/start.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>WorkingDirectory</key>
    <string>${PERSISTENT_DIR}</string>
    <key>StandardOutPath</key>
    <string>${PERSISTENT_DIR}/output.log</string>
    <key>StandardErrorPath</key>
    <string>${PERSISTENT_DIR}/output.log</string>
</dict>
</plist>
EOF
  launchctl load "$PLIST_PATH" 2>/dev/null || true
  echo "✅ Автозапуск: $PLIST_PATH → $PERSISTENT_DIR/start.sh"
fi

echo "🚀 Запуск AutoClick..."
nohup node "$SCRIPT_DIR/auto-click.js" > "$SCRIPT_DIR/output.log" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "AutoClick запущен, PID: $NEW_PID"
