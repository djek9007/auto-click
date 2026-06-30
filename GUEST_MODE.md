# AutoClick — Режим гостевого аккаунта macOS

Если вы используете **Guest Account** на macOS, домашняя папка удаляется при logout.
Чтобы скрипт переживал выход из системы, он автоматически копируется в `/Users/Shared/.auto-click/`.

## Автоматическая установка (рекомендуется)

Просто запустите:
```bash
bash start.sh
```

Скрипт сам:
1. Проверит .env
2. Скопирует проект в `/Users/Shared/.auto-click/`
3. Установит зависимости
4. Удалит исходную папку
5. Запустит из персистентной директории

При следующем входе — просто `bash start.sh`, он найдёт копию и запустит оттуда.

## Ручная установка

```bash
# Скопировать проект (точка в начале — скрытая папка)
cp -r "$(dirname "$0")" /Users/Shared/.auto-click

# Установить зависимости
cd /Users/Shared/.auto-click
npm install

# Настроить .env
cp .env.example .env
# Отредактировать .env — ввести EMAIL, PASSWORD, TELEGRAM_TOKEN

# Запустить
bash start.sh
```

## Запуск после входа как гость

```bash
cd /Users/Shared/.auto-click && bash start.sh
```

## Управление

- **Telegram:** писать боту `/start`, `/stop`, `/status`
- **Остановить:** нажать `Ctrl+C` в терминале

## Показать скрытую папку

```bash
ls -la /Users/Shared/          # увидите .auto-click
ls -la /Users/Shared/.auto-click/  # увидите файлы проекта
```

## Что сохраняется между сессиями

- `/Users/Shared/.auto-click/.env` — настройки
- `/Users/Shared/.auto-click/node_modules/` — зависимости
- `/Users/Shared/.auto-click/.tg_session` — сессия Telegram
- `/Users/Shared/.auto-click/.tg_offset` — смещение обновлений

## Примечание

Папка `.auto-click` скрыта из Finder и терминала (ls без -a не покажет).
Доступна через `ls -la` или `cd /Users/Shared/.auto-click`.
