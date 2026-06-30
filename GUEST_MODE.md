# AutoClick — Режим гостевого аккаунта macOS

Если вы используете **Guest Account** на macOS, домашняя папка удаляется при logout.
Чтобы скрипт переживал выход из системы, скопируйте его в `/Users/Shared/`.

## Установка (один раз)

```bash
# Скопировать проект
cp -r "$(dirname "$0")" /Users/Shared/auto-click

# Скрыть папку из Finder
chflags hidden /Users/Shared/auto-click

# Установить зависимости
cd /Users/Shared/auto-click
npm install

# Настроить .env
cp .env.example .env
# Отредактировать .env — ввести EMAIL, PASSWORD, TELEGRAM_TOKEN

# Запустить
bash start.sh
```

## Запуск после входа как гость

```bash
cd /Users/Shared/auto-click && bash start.sh
```

## Управление

- **Telegram:** писать боту `/start`, `/stop`, `/status`
- **Остановить:** нажать `Ctrl+C` в терминале

## Показать скрытую папку

```bash
chflags nohidden /Users/Shared/auto-click
```

## Что сохраняется между сессиями

- `/Users/Shared/auto-click/.env` — настройки
- `/Users/Shared/auto-click/node_modules/` — зависимости
- `/Users/Shared/auto-click/.tg_session` — сессия Telegram
- `/Users/Shared/auto-click/.tg_offset` — смещение обновлений

## Примечание

Без sudo доступа невозможно настроить автозапуск через LaunchDaemon.
Скрипт нужно запускать вручную после каждого входа как гость.
