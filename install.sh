#!/bin/bash
# ============================================================
# install.sh — Установка AutoClick в систему с автозапуском
#
# Поддерживает:
#   - macOS (LaunchDaemon) — автозапуск при загрузке Mac
#   - Linux (systemd)       — автозапуск при загрузке Linux
#
# Файлы устанавливаются в /usr/local/autoclick/
# Эта папка НЕ сбрасывается при logout системы.
#
# Использование:
#   sudo bash install.sh
# ============================================================

set -e

APP_DIR="/usr/local/autoclick"
SCRIPT_SRC="$(cd "$(dirname "$0")" && pwd)/auto-click.js"
NODE_BIN="$(command -v node || true)"

echo "========================================"
echo " Установка AutoClick v2.0"
echo "========================================"

# Проверка прав
if [ "$EUID" -ne 0 ]; then
  echo "❌ Запустите с sudo: sudo bash install.sh"
  exit 1
fi

# Определение ОС
OS="$(uname -s)"
echo "🔍 Обнаружена ОС: $OS"

# Проверка Node.js
if [ -z "$NODE_BIN" ]; then
  echo "❌ Node.js не найден! Установите:"
  echo "   macOS: brew install node"
  echo "   Linux: apt install nodejs npm"
  exit 1
fi
echo "✅ Node.js: $($NODE_BIN --version)"
echo "✅ Путь: $NODE_BIN"

# Проверка исходного файла
if [ ! -f "$SCRIPT_SRC" ]; then
  echo "❌ Файл auto-click.js не найден рядом со скриптом установки"
  exit 1
fi

# ─── 1. Копирование файлов ─────────────────────────────────
echo ""
echo "📁 Создание $APP_DIR ..."
mkdir -p "$APP_DIR"

echo "📄 Копирование auto-click.js..."
cp "$SCRIPT_SRC" "$APP_DIR/auto-click.js"

echo "📄 Копирование package.json..."
if [ -f "$(dirname "$0")/package.json" ]; then
  cp "$(dirname "$0")/package.json" "$APP_DIR/"
else
  cat > "$APP_DIR/package.json" << 'EOF'
{
  "name": "dashboard-autoclick",
  "version": "2.0.0",
  "description": "Автоматическая активность на Tomorrow School Dashboard",
  "main": "auto-click.js",
  "dependencies": {
    "puppeteer": "^24.0.0"
  }
}
EOF
fi

# ─── 2. Установка зависимостей ─────────────────────────────
echo ""
echo "📦 Установка Puppeteer + Chromium (может занять несколько минут)..."
cd "$APP_DIR"
npm install --no-fund --no-audit 2>&1 | tail -5
echo "✅ Зависимости установлены"

# ─── 3. Создание службы автозапуска ────────────────────────
echo ""
echo "⚙️ Настройка автозапуска..."

case "$OS" in
  Darwin)
    # ── macOS: LaunchDaemon ──
    PLIST_PATH="/Library/LaunchDaemons/com.autoclick.plist"
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
        <string>${NODE_BIN}</string>
        <string>${APP_DIR}/auto-click.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${APP_DIR}</string>
    <key>StandardOutPath</key>
    <string>${APP_DIR}/output.log</string>
    <key>StandardErrorPath</key>
    <string>${APP_DIR}/error.log</string>
    <key>UserName</key>
    <string>root</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>${APP_DIR}</string>
    </dict>
</dict>
</plist>
EOF
    chmod 644 "$PLIST_PATH"
    echo "✅ LaunchDaemon создан: $PLIST_PATH"

    # Загрузка
    launchctl load -w "$PLIST_PATH" 2>/dev/null || true
    echo "🚀 LaunchDaemon загружен"

    # Инструкции
    echo ""
    echo "📌 Команды для macOS:"
    echo "   Остановить:     sudo launchctl unload $PLIST_PATH"
    echo "   Перезапустить:  sudo launchctl unload $PLIST_PATH && sudo launchctl load $PLIST_PATH"
    echo "   Проверить:      sudo launchctl list | grep autoclick"
    ;;

  Linux)
    # ── Linux: systemd ──
    SERVICE_PATH="/etc/systemd/system/autoclick.service"
    cat > "$SERVICE_PATH" << EOF
[Unit]
Description=AutoClick — Tomorrow School Dashboard activity
After=network.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${APP_DIR}/auto-click.js
WorkingDirectory=${APP_DIR}
Restart=always
RestartSec=10
Environment="PATH=/usr/local/bin:/usr/bin:/bin"
StandardOutput=append:${APP_DIR}/output.log
StandardError=append:${APP_DIR}/error.log

[Install]
WantedBy=multi-user.target
EOF
    chmod 644 "$SERVICE_PATH"
    echo "✅ systemd service создан: $SERVICE_PATH"

    # Включение и запуск
    systemctl daemon-reload
    systemctl enable autoclick.service
    systemctl start autoclick.service
    echo "🚀 systemd service запущен и добавлен в автозагрузку"

    # Инструкции
    echo ""
    echo "📌 Команды для Linux:"
    echo "   Остановить:     sudo systemctl stop autoclick"
    echo "   Перезапустить:  sudo systemctl restart autoclick"
    echo "   Проверить:      sudo systemctl status autoclick"
    echo "   Логи:           sudo journalctl -u autoclick -f"
    ;;

  *)
    echo "⚠️ Неизвестная ОС: $OS"
    echo "  Скрипт установлен в $APP_DIR, но автозапуск не настроен."
    echo "  Запускайте вручную: cd $APP_DIR && node auto-click.js"
    ;;
esac

# ─── 4. Права ──────────────────────────────────────────────
chown -R root:wheel "$APP_DIR" 2>/dev/null || chown -R root:root "$APP_DIR" 2>/dev/null || true

echo ""
echo "========================================"
echo " ✅ Установка завершена!"
echo "========================================"
echo ""
echo "📁 Скрипт установлен: ${APP_DIR}/auto-click.js"
echo "📄 Логи:             ${APP_DIR}/output.log"
echo "📱 Telegram бот:     @OlzhtomBot"
echo ""
echo "🔥 Скрипт запущен и будет автоматически"
echo "   стартовать при загрузке системы."
echo ""
echo "   /status — проверить статус"
echo "   /stop   — остановить"
echo "   /start  — запустить снова"
