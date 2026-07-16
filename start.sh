#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── Находим Node.js и npm/npx ───
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/*/bin:$PATH"
NODE_BIN="$(command -v node 2>/dev/null || true)"
NPM_BIN="$(command -v npm 2>/dev/null || true)"
NPX_BIN="$(command -v npx 2>/dev/null || true)"

# Если npx не найден — ищем в стандартных местах
if [ -z "$NPX_BIN" ]; then
  for d in /usr/local/bin /opt/homebrew/bin /usr/bin; do
    if [ -x "$d/npx" ]; then
      export PATH="$d:$PATH"
      NPX_BIN="$d/npx"
      break
    fi
  done
fi

# Если всё ещё не найден — ищем через find
if [ -z "$NPX_BIN" ]; then
  NPX_BIN="$(find /usr/local /opt/homebrew $HOME -name npx -type f -perm +111 2>/dev/null | head -1)"
  if [ -n "$NPX_BIN" ]; then
    export PATH="$(dirname "$NPX_BIN"):$PATH"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  echo "❌ Node.js не найден! Установите:"
  echo "   brew install node"
  exit 1
fi
echo "✅ Node.js: $NODE_BIN, npm: ${NPM_BIN:-найду}, npx: ${NPX_BIN:-найду}"

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
    cd "$PERSISTENT_DIR" && $NPM_BIN install --no-fund --no-audit 2>&1 | tail -3

    echo "🌐 Скачивание Chrome..."
    cd "$PERSISTENT_DIR" && $NPX_BIN puppeteer browsers install chrome 2>&1 | tail -3

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

echo "📄 Загрузка .env из: $ENV_FILE"

# Загружаем переменные
set -a
source "$ENV_FILE"
set +a

# Диагностика загруженных переменных
echo "🔍 Проверка переменных после source:"
echo "   EMAIL: ${EMAIL:+задан (значение скрыто)}"
echo "   PASSWORD: ${PASSWORD:+задан (значение скрыто)}"
echo "   TELEGRAM_TOKEN: ${TELEGRAM_TOKEN:+задан (значение скрыто)}"
echo "   CONFIG_GIST_ID: ${CONFIG_GIST_ID:+задан (значение скрыто)}"
echo "   GIST_ID: ${GIST_ID:+задан (значение скрыто)}"
echo "   GITHUB_TOKEN: ${GITHUB_TOKEN:+задан (значение скрыто)}"

if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ] || [ -z "$TELEGRAM_TOKEN" ]; then
  if [ -z "$CONFIG_GIST_ID" ]; then
    echo "❌ Не все переменные заданы в .env и нет CONFIG_GIST_ID!"
    exit 1
  else
    echo "⚠️  Локальные переменные неполные, будут загружены из Gist"
  fi
fi

echo "✅ Конфигурация: ${EMAIL:-из Gist}"
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
  echo "⚠️  github.com не резолвится"
  GITHUB_IP="140.82.121.3"
  # Проверяем, есть ли уже запись
  if grep -q "github.com" /etc/hosts 2>/dev/null; then
    echo "✅ github.com уже в /etc/hosts"
  else
    echo "❌ DNS не работает. Добавьте вручную:"
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

# Проверка Chrome — ищем бинарник (Chromium или Google Chrome for Testing)
CHROME_BIN=$(find "$SCRIPT_DIR/node_modules/.cache/puppeteer" -name "Chromium" -type f 2>/dev/null | head -1)
if [ -z "$CHROME_BIN" ]; then
  # На macOS это может быть "Google Chrome for Testing"
  CHROME_BIN=$(find "$SCRIPT_DIR/node_modules/.cache/puppeteer" -name "Google Chrome for Testing" -type f 2>/dev/null | head -1)
fi
if [ -z "$CHROME_BIN" ]; then
  echo "🌐 Установка Chrome для Puppeteer..."
  cd "$SCRIPT_DIR" && $NPX_BIN puppeteer browsers install chrome 2>&1 | tail -3
  # Проверяем снова
  CHROME_BIN=$(find "$SCRIPT_DIR/node_modules/.cache/puppeteer" -name "Chromium" -type f 2>/dev/null | head -1)
  if [ -z "$CHROME_BIN" ]; then
    CHROME_BIN=$(find "$SCRIPT_DIR/node_modules/.cache/puppeteer" -name "Google Chrome for Testing" -type f 2>/dev/null | head -1)
  fi
  if [ -z "$CHROME_BIN" ]; then
    echo "⚠️  Chrome не найден после установки!"
  else
    echo "✅ Chrome установлен: $CHROME_BIN"
  fi
else
  echo "✅ Chrome найден: $CHROME_BIN"
fi

# ─── Автозапуск — пересоздаём LaunchAgent только если он изменился ───
# ВАЖНО: launchctl load с RunAtLoad=true сразу порождает параллельный запуск
# start.sh. Если делать unload/load на каждом запуске (в т.ч. из-под самого
# LaunchAgent), этот параллельный экземпляр убивает только что стартовавший
# node (секция kill выше) и сам гибнет на unload — бот не успевает пожить.
# Поэтому трогаем launchd только когда plist реально отсутствует/устарел.
if [ "$(uname -s)" = "Darwin" ]; then
  NEW_PLIST=$(cat << EOF
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
)

  if [ "$(cat "$PLIST_PATH" 2>/dev/null || true)" != "$NEW_PLIST" ]; then
    echo "⚙️ Настройка автозапуска..."
    mkdir -p "$HOME/Library/LaunchAgents"
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    echo "$NEW_PLIST" > "$PLIST_PATH"
    launchctl load "$PLIST_PATH" 2>/dev/null || true
    echo "✅ Автозапуск: $PLIST_PATH → $PERSISTENT_DIR/start.sh"
  fi
fi

echo "🚀 Запуск AutoClick..."
echo "" >> "$SCRIPT_DIR/output.log"
echo "═══════════════════════════════════════════════════════════════" >> "$SCRIPT_DIR/output.log"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Запуск start.sh" >> "$SCRIPT_DIR/output.log"

# Проверка что output.log доступен для записи
if ! touch "$SCRIPT_DIR/output.log" 2>/dev/null; then
  echo "❌ Ошибка: не могу писать в output.log"
  echo "   Проверьте права: ls -la $SCRIPT_DIR/output.log"
  exit 1
fi

# Если передан аргумент --foreground, запускаем в foreground для диагностики
if [ "$1" = "--foreground" ] || [ "$1" = "-f" ]; then
  echo "🔍 Запуск в foreground (Ctrl+C для остановки)..."
  node "$SCRIPT_DIR/auto-click.js" 2>&1 | tee -a "$SCRIPT_DIR/output.log"
else
  nohup node "$SCRIPT_DIR/auto-click.js" >> "$SCRIPT_DIR/output.log" 2>&1 &
  NEW_PID=$!
  echo "$NEW_PID" > "$PID_FILE"
  echo "AutoClick запущен, PID: $NEW_PID"
  echo ""
  echo "📋 Логи: tail -f $SCRIPT_DIR/output.log"
  echo "🔍 Для диагностики: bash start.sh --foreground"
fi
