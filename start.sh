#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── Автоматическая установка в /Users/Shared/ (macOS Guest Account) ───
PERSISTENT_DIR="/Users/Shared/.auto-click"
SHOULD_RELOCATE=false

if [ "$(uname -s)" = "Darwin" ]; then
  if echo "$SCRIPT_DIR" | grep -q '^/Users/Shared/'; then
    echo "✅ Уже в портативной директории"
  elif [ -d "$PERSISTENT_DIR" ]; then
    echo "📂 Найдена портативная копия: $PERSISTENT_DIR"
    echo "▶️  Запуск из персистентной директории..."
    exec bash "$PERSISTENT_DIR/start.sh" "$@"
  else
    SHOULD_RELOCATE=true
  fi
fi

if [ "$SHOULD_RELOCATE" = true ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════╗"
  echo "║  🔄 Первый запуск — подготовка к установке      ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo ""

  # ─── Шаг 1: Проверяем .env ДО копирования ───
  echo "📋 Проверка конфигурации..."

  if [ ! -f "$SCRIPT_DIR/.env" ]; then
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

  set -a
  source "$SCRIPT_DIR/.env"
  set +a

  if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ] || [ -z "$TELEGRAM_TOKEN" ]; then
    # If CONFIG_GIST_ID is set, values will be loaded from Gist — skip validation
    if [ -z "$CONFIG_GIST_ID" ]; then
      echo ""
      echo "╔══════════════════════════════════════════╗"
      echo "║  ❌ Не все переменные заданы в .env!     ║"
      echo "╚══════════════════════════════════════════╝"
      echo ""
      [ -z "$EMAIL" ] && echo "  ❌ EMAIL — не задан"
      [ -z "$PASSWORD" ] && echo "  ❌ PASSWORD — не задан"
      [ -z "$TELEGRAM_TOKEN" ] && echo "  ❌ TELEGRAM_TOKEN — не задан"
      echo ""
      exit 1
    fi
    echo "⚠️  Загрузка из Gist ($CONFIG_GIST_ID)"
  fi

  echo "✅ .env корректен: ${EMAIL:-из Gist}"
  echo ""

  # ─── Шаг 2: Копируем проект ───
  echo "📁 Копирование в $PERSISTENT_DIR ..."
  mkdir -p "$PERSISTENT_DIR"
  rsync -a --exclude='node_modules' --exclude='output.log' --exclude='output.log.1' "$SCRIPT_DIR/" "$PERSISTENT_DIR/"

  # Убеждаемся что .env на месте
  if [ ! -f "$PERSISTENT_DIR/.env" ]; then
    cp "$SCRIPT_DIR/.env" "$PERSISTENT_DIR/.env"
  fi

  # Папка уже скрыта благодаря точке в начале имени (.auto-click)
  echo "📁 Папка скрыта из Finder и терминала"

  # ─── Шаг 3: Устанавливаем зависимости ───
  echo ""
  echo "📦 Установка зависимостей..."
  cd "$PERSISTENT_DIR" && npm install --no-fund --no-audit 2>&1 | tail -3

  # Устанавливаем Chrome для Puppeteer если нужно
  if ! npx puppeteer browsers installed 2>/dev/null | grep -q chrome; then
    echo "🌐 Скачивание Chrome для Puppeteer..."
    cd "$PERSISTENT_DIR" && npx puppeteer browsers install chrome 2>&1 | tail -3
  fi

  echo ""
  echo "✅ Установка завершена!"
  echo "📁 Проект: $PERSISTENT_DIR"
  echo ""

  # ─── Шаг 4: Удаляем исходную папку ───
  # Не удаляем если это /, /Users/Shared, или уже в целевой директории
  if [ "$SCRIPT_DIR" != "/" ] && [ "$SCRIPT_DIR" != "$PERSISTENT_DIR" ] && [ "$SCRIPT_DIR" != "/Users/Shared" ]; then
    echo "🗑  Удаление исходной папки: $SCRIPT_DIR"
    rm -rf "$SCRIPT_DIR"
    echo "✅ Исходная папка удалена — следов нет"
    echo ""
  fi

  # ─── Шаг 5: Запускаем из персистентной директории ───
  exec bash "$PERSISTENT_DIR/start.sh" "$@"
fi

# ─── Основная логика запуска ──────────────────────────────────────────
PID_FILE="$SCRIPT_DIR/.auto-click.pid"
ENV_FILE="$SCRIPT_DIR/.env"

# Проверяем наличие .env файла
if [ ! -f "$ENV_FILE" ]; then
  echo ""
  echo "╔══════════════════════════════════════════╗"
  echo "║  ❌ Файл .env не найден!                ║"
  echo "╚══════════════════════════════════════════╝"
  echo ""
  exit 1
fi

# Проверяем что переменные заданы
set -a
source "$ENV_FILE"
set +a

if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ] || [ -z "$TELEGRAM_TOKEN" ]; then
  # If CONFIG_GIST_ID is set, values will be loaded from Gist — skip validation
  if [ -z "$CONFIG_GIST_ID" ]; then
    echo ""
    echo "╔══════════════════════════════════════════╗"
    echo "║  ❌ Не все переменные заданы в .env!     ║"
    echo "╚══════════════════════════════════════════╝"
    echo ""
    exit 1
  fi
  echo "⚠️  Некоторые переменные не заданы — будут загружены из Gist ($CONFIG_GIST_ID)"
fi

echo "✅ Конфигурация загружена: $EMAIL"
echo "📁 Директория: $SCRIPT_DIR"
echo "💡 Портативный режим: файлы в /Users/Shared/ сохраняются при logout"

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

# Kill any remaining instances by PID
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
  # Устанавливаем Chrome для Puppeteer если нужно
  if ! npx puppeteer browsers installed 2>/dev/null | grep -q chrome; then
    echo "🌐 Скачивание Chrome для Puppeteer..."
    cd "$SCRIPT_DIR" && npx puppeteer browsers install chrome 2>&1 | tail -3
  fi
fi

nohup node "$SCRIPT_DIR/auto-click.js" > "$SCRIPT_DIR/output.log" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "AutoClick запущен, PID: $NEW_PID"
