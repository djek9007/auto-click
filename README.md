# AutoClick — Tomorrow School Dashboard Automation

> Скрипт логинится на dashboard.tomorrow-school.ai, запускает учёт времени
> и имитирует активность (скролл + клики) каждые 5–12 минут.
> Управление через Telegram бота.

---

## 📦 Установка

### Способ 1 — git clone (рекомендуется)

```bash
git clone git@github.com:djek9007/auto-click.git
cd auto-click
npm install
```

Создайте `.env` файл в папке с проектом:

```env
EMAIL=your@email.com
PASSWORD=your_password
TELEGRAM_TOKEN=your_bot_token_from_@BotFather
```

Запуск:

```bash
bash start.sh
# или напрямую:
node auto-click.js
```

### Способ 2 — системная установка (автозапуск при загрузке)

Установить и забыть:

```bash
cd ~/Documents/tomorrow/auto-click
sudo bash install.sh
```

Ввели пароль — скрипт запущен. Теперь при каждом включении Mac он стартует сам.
Управляете через Telegram бота **@OlzhtomBot**.

> Если у вас сбрасываются файлы при logout — неважно. Скрипт установлен в систему,
> а не в вашу домашнюю папку. Он переживёт logout и перезагрузку.

---

## ⏹ Остановка

**Способ 1 — Telegram:** напишите боту `/stop`

**Способ 2 — терминал:** нажмите `Ctrl + C`

**Способ 3 — автоматически:** скрипт сам остановится через 10 часов

---

## 📱 Управление через Telegram (бот @OlzhtomBot)

После запуска скрипта на компьютере — просто откройте Telegram и нажмите любую кнопку:

```
▶️ Запустить
⏹ Остановить
📊 Статус
🔄 Перезапустить
```

Бот сам присылает меню с кнопками. Можно также писать текстом: `/start`, `/stop`, `/status`, `/restart`.

### Уведомления от бота
- 🔓 Успешный вход в систему
- ✅ 10 часов истекло
- ❌ Ошибка, если что-то пошло не так

---

## 💻 Вариант 1: Быстрый запуск (просто тест)

```bash
cd ~/Documents/tomorrow/auto-click
node auto-click.js
```

Скрипт работает пока открыт терминал. Нажми `Ctrl+C` чтобы остановить.

---

## ⚡ Вариант 2: Автозапуск при загрузке системы (РЕКОМЕНДУЕТСЯ)

Скрипт устанавливается в `/usr/local/autoclick/` и запускается **автоматически при каждой загрузке компьютера**.
Не важно, кто залогинен и был ли logout — скрипт живёт отдельно.

Поддерживает **macOS** (LaunchDaemon) и **Linux** (systemd).

```bash
cd ~/Documents/tomorrow/auto-click
sudo bash install.sh
```

Ввёл пароль — и всё. Дальше компьютер можно выключать и включать — скрипт стартует сам.

**Управление — только через Telegram:** @OlzhtomBot

### Проверить что работает

**macOS:**
```bash
sudo launchctl list | grep autoclick
cat /usr/local/autoclick/output.log
```

**Linux:**
```bash
sudo systemctl status autoclick
cat /usr/local/autoclick/output.log
```

### Остановить / перезапустить

**macOS:**
```bash
# Остановить
sudo launchctl unload /Library/LaunchDaemons/com.autoclick.plist

# Перезапустить
sudo launchctl unload /Library/LaunchDaemons/com.autoclick.plist && sudo launchctl load /Library/LaunchDaemons/com.autoclick.plist
```

**Linux:**
```bash
sudo systemctl stop autoclick        # остановить
sudo systemctl restart autoclick     # перезапустить
```

### Удалить из системы
```bash
cd ~/Documents/tomorrow/auto-click
sudo bash uninstall.sh
```

### Как это работает
1. Скрипт копируется в `/usr/local/autoclick/` — это системная папка, **не сбрасывается при logout**
2. Создаётся служба автозапуска (LaunchDaemon на Mac / systemd на Linux), которая запускает скрипт при старте системы, **до входа любого пользователя**
3. Если скрипт упадёт — система сама его перезапустит

---

## 💻 Вариант 3: Фоновый режим (без установки)

```bash
nohup node auto-click.js > output.log &
```

Скрипт работает в фоне. Можно закрыть терминал.
Чтобы остановить:
```bash
kill $(pgrep -f auto-click)
```
Логи: `cat output.log`

---

## 🔧 Настройка

Все настройки передаются через переменные среды или `.env` файл в папке проекта:

```bash
# Создайте файл .env:
EMAIL=your@email.com
PASSWORD=your_password
TELEGRAM_TOKEN=токен_бота_от_@BotFather
```

Или через командную строку:
```bash
EMAIL=my@email.com PASSWORD=pass TELEGRAM_TOKEN=токен node auto-click.js
```

### Дополнительные настройки

```bash
HEADLESS=false    # Показать браузер (для отладки)
MAX_HOURS=10      # Лимит работы (часов)
MIN_INTERVAL_MIN=5  # Мин. пауза между кликами
MAX_INTERVAL_MIN=12 # Макс. пауза между кликами
SLOW_MO=50        # Замедлить действия (мс)
```

Пример:
```bash
HEADLESS=false SLOW_MO=50 node auto-click.js
```

---

## 📋 Что делает скрипт

1. Открывает headless-браузер (невидимый)
2. Заходит на dashboard.tomorrow-school.ai
3. Авторизуется через Gitea + 01-platform
4. Нажимает «Запустить учёт» (если не запущен)
5. Каждые 5–12 минут:
   - Скроллит страницу
   - Наводит курсор на кнопку меню
   - Кликает
6. Проверяет сессию — если разлогинило, заходит снова
7. Через 10 часов автоматически останавливается

---

## ❓ Частые вопросы

**Q: Нужно ли держать Mac включённым?**
Да. Если Mac уйдёт в сон — скрипт встанет на паузу. Настройте «Не уходить в сон» в Energy Saver.

**Q: Можно ли закрыть крышку ноутбука?**
Если закрыть крышку — Mac уснёт, скрипт остановится. Оставляйте ноутбук открытым.

**Q: Что если сайт изменится?**
Скрипт может перестать находить кнопки. Напишите мне — исправлю.

**Q: Как часто кликает?**
Рандомно от 5 до 12 минут — чтобы не было подозрительно одинаковых интервалов.

---

## ⚠️ Безопасность

Пароль и токен Telegram хранятся прямо в `auto-click.js`.
**Не отправляйте этот файл никому.**
Если хотите большей безопасности — удалите данные из `CREDENTIALS` и передавайте через переменные среды:

```javascript
const CREDENTIALS = {
  email:          '',
  password:       '',
  telegramToken:  '',
};
```

```bash
EMAIL=ваш_email PASSWORD=ваш_пароль TELEGRAM_TOKEN=токен node auto-click.js
```
