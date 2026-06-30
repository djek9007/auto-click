#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── Автоматическая установка в /Users/Shared/ (macOS Guest Account) ───
PERSISTENT_DIR="/Users/Shared/.auto-click"

if [ "$(uname -s)" = "Darwin" ]; then
  # Уже в правильной папке — запускаем
  if [ "$SCRIPT_DIR" = "$PERSISTENT_DIR" ]; then
    echo "✅ Запуск из $PERSISTENT_DIR"
  # Есть копия в Shared — переключаемся на неё
  elif [ -d "$PERSISTENT_DIR" ]; then
    echo "📂 Переход в $PERSISTENT_DIR..."
    # Удаляем исходную папку если это не Shared и не корень
    if [ "$SCRIPT_DIR" != "/" ] && [ "$SCRIPT_DIR" != "$PERSISTENT_DIR" ] && [ "$SCRIPT_DIR" != "/Users/Shared" ]; then
      echo "🗑  Удаление исходной папки: $SCRIPT_DIR"
      rm -rf "$SCRIPT_DIR"
      echo "✅ Исходная папка удалена"
    fi
    exec bash "$PERSISTENT_DIR/start.sh" "$@"
  # Первый запуск — копируем
  else
    echo ""
    echo "╔══════════════════════════════════════════════════╗"
    echo "║  🔄 Первый запуск — установка                   ║"
    echo "╚══════════════════════════════════════════════════╝"
    echo ""

    # Проверяем .env ДО копирования
    if [ ! -f "$SCRIPT_DIR/.env" ]; then
      echo "❌ Файл .env не найден в $SCRIPT_DIR"
      echo "   cp .env.example .env"
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

    # Копируем проект
    echo "📁 Копирование в $PERSISTENT_DIR ..."
    mkdir -p "$PERSISTENT_DIR"
    rsync -a --exclude='node_modules' --exclude='output.log' --exclude='output.log.1' "$SCRIPT_DIR/" "$PERSISTENT_DIR/"

    # Убеждаемся что .env на месте
    [ ! -f "$PERSISTENT_DIR/.env" ] && cp "$SCRIPT_DIR/.env" "$PERSISTENT_DIR/.env"

    # Устанавливаем зависимости
    echo "📦 Установка зависимостей..."
    cd "$PERSISTENT_DIR" && npm install --no-fund --no-audit 2>&1 | tail -3

    # Скачиваем Chrome для Puppeteer
    echo "🌐 Скачивание Chrome..."
    cd "$PERSISTENT_DIR" && npx puppeteer browsers install chrome 2>&1 | tail -3

    echo "✅ Установка завершена!"

    # Удаляем исходную папку
    if [ "$SCRIPT_DIR" != "/" ] && [ "$SCRIPT_DIR" != "$PERSISTENT_DIR" ]; then
      echo "🗑  Удаление исходной папки: $SCRIPT_DIR"
      rm -rf "$SCRIPT_DIR"
      echo "✅ Исходная папка удалена"
    fi

    # Запускаем из правильной директории
    exec bash "$PERSISTENT_DIR/start.sh" "$@"
  fi
fi

# ─── Основная логика запуска ──────────────────────────────────────────
PID_FILE="$SCRIPT_DIR/.auto-click.pid"
ENV_FILE="$SCRIPT_DIR/.env"

# Проверяем .env
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
# Добиваем если живы
for pid in $(ps axo pid,comm | grep '[n]ode' | awk '{print $1}' || true); do
  args=$(ps -p "$pid" -o args= 2>/dev/null || true)
  if echo "$args" | grep -q 'auto-click.js'; then
    kill -9 "$pid" 2>/dev/null || true
  fi
done

# Удаляем PID файл
rm -f "$PID_FILE"

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

# Установка Chrome если нужно
CHROME_DIR="$SCRIPT_DIR/node_modules/.cache/puppeteer"
if [ ! -d "$CHROME_DIR" ] || [ -z "$(ls "$CHROME_DIR" 2>/dev/null)" ]; then
  echo "🌐 Установка Chrome для Puppeteer..."
  cd "$SCRIPT_DIR" && npx puppeteer browsers install chrome 2>&1 | tail -3
fi

echo "🚀 Запуск AutoClick..."
nohup node "$SCRIPT_DIR/auto-click.js" > "$SCRIPT_DIR/output.log" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "AutoClick запущен, PID: $NEW_PID"
