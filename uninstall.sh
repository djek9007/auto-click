#!/bin/bash
# ============================================================
# uninstall.sh — Удаление AutoClick из системы
#
# Поддерживает macOS (LaunchDaemon) и Linux (systemd)
#
# Использование:
#   sudo bash uninstall.sh
# ============================================================

set -e

APP_DIR="/usr/local/autoclick"

echo "========================================"
echo " Удаление AutoClick"
echo "========================================"

if [ "$EUID" -ne 0 ]; then
  echo "❌ Запустите с sudo: sudo bash uninstall.sh"
  exit 1
fi

OS="$(uname -s)"

# Остановка и удаление службы
case "$OS" in
  Darwin)
    PLIST_PATH="/Library/LaunchDaemons/com.autoclick.plist"
    if [ -f "$PLIST_PATH" ]; then
      echo "⏹ Остановка LaunchDaemon..."
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      rm -f "$PLIST_PATH"
      echo "✅ LaunchDaemon удалён"
    fi
    ;;
  Linux)
    SERVICE_PATH="/etc/systemd/system/autoclick.service"
    if [ -f "$SERVICE_PATH" ]; then
      echo "⏹ Остановка systemd service..."
      systemctl stop autoclick.service 2>/dev/null || true
      systemctl disable autoclick.service 2>/dev/null || true
      rm -f "$SERVICE_PATH"
      systemctl daemon-reload
      echo "✅ systemd service удалён"
    fi
    ;;
esac

# Остановка запущенных процессов
echo "⏹ Остановка запущенных процессов..."
for pid in $(ps axo pid,comm | grep '[n]ode' | awk '{print $1}'); do
  args=$(ps -p "$pid" -o args= 2>/dev/null)
  if echo "$args" | grep -q 'auto-click.js' && ! echo "$args" | grep -q 'pgrep'; then
    echo "  Останавливаю PID $pid..."
    kill "$pid" 2>/dev/null || true
  fi
done
sleep 2
for pid in $(ps axo pid,comm | grep '[n]ode' | awk '{print $1}'); do
  args=$(ps -p "$pid" -o args= 2>/dev/null)
  if echo "$args" | grep -q 'auto-click.js' && ! echo "$args" | grep -q 'pgrep'; then
    kill -9 "$pid" 2>/dev/null || true
  fi
done

# Очистка runtime-файлов из директории проекта
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
rm -f "$SCRIPT_DIR/.auto-click.pid" "$SCRIPT_DIR/.tg_offset" "$SCRIPT_DIR/.tg_session" 2>/dev/null || true
rm -f "$SCRIPT_DIR/output.log" "$SCRIPT_DIR/output.log.1" 2>/dev/null || true
rm -rf "$SCRIPT_DIR/.screenshots" 2>/dev/null || true

# Удаление файлов
if [ -d "$APP_DIR" ]; then
  echo "🗑 Удаление $APP_DIR ..."
  rm -rf "$APP_DIR"
  echo "✅ Файлы удалены"
fi

echo ""
echo "✅ AutoClick полностью удалён из системы"
