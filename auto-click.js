#!/usr/bin/env node

/**
 * auto-click.js — Автоматическая активность на учебном dashboard
 *
 * Использование:
 *   node auto-click.js
 *
 * Управление через Telegram бота @OlzhtomBot:
 *   /start   — запустить автоклик
 *   /stop    — остановить
 *   /status  — статус (прошло, осталось, кликов)
 *   /restart — перезапустить таймер
 *
 * Требования: Node.js 18+, npm install puppeteer
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const OFFSET_FILE  = path.join(__dirname, '.tg_offset');
const SESSION_FILE = path.join(__dirname, '.tg_session');
const PID_FILE     = path.join(__dirname, '.auto-click.pid');

// Write own PID; remove on exit to avoid stale file
try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch {} });

function loadOffset()  { try { return parseInt(fs.readFileSync(OFFSET_FILE,'utf8'))||0; } catch { return 0; } }
function saveOffset(n) { try { fs.writeFileSync(OFFSET_FILE, String(n)); } catch {} }

function loadSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return {}; }
}
function saveSession() {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({
      chatId:        state.telegramChatId,
      menuMessageId: state.lastMenuMessageId,
    }));
  } catch {}
}

// ─── Configuration ─────────────────────────────────────────────────────────────
// Все настройки передаются через переменные среды или .env файл.
// EMAIL       — email для входа
// PASSWORD    — пароль для входа
// TELEGRAM_TOKEN — токен Telegram бота
// HEADLESS    — false чтобы видеть браузер (по умолчанию true)
// AUTO_START  — true чтобы автозапуск без команды из Telegram
//
//   EMAIL=my@email.com PASSWORD=pass TELEGRAM_TOKEN=токен node auto-click.js
//
const CONFIG = {
  email:           process.env.EMAIL,
  password:        process.env.PASSWORD,
  telegramToken:   process.env.TELEGRAM_TOKEN,
  targetUrl:       process.env.TARGET_URL || 'https://dashboard.tomorrow-school.ai',
  maxHours:        parseInt(process.env.MAX_HOURS || '10', 10),
  minIntervalMin:  parseInt(process.env.MIN_INTERVAL_MIN || '5', 10),
  maxIntervalMin:  parseInt(process.env.MAX_INTERVAL_MIN || '12', 10),
  headless:        process.env.HEADLESS !== 'false',
  slowMo:          parseInt(process.env.SLOW_MO || '0', 10),

  // School coordinates for geolocation override
  latitude:        51.089159,
  longitude:       71.415595,
  accuracy:        10,
};

// ─── State ─────────────────────────────────────────────────────────────────────
const _savedSession = loadSession();
const state = {
  startTime:          null,
  clickCount:         0,
  isRunning:          false,
  startingUp:         false,
  browser:            null,
  page:               null,
  telegramOffset:     loadOffset(),
  telegramChatId:     _savedSession.chatId     || null,
  lastMenuMessageId:  _savedSession.menuMessageId || null,
  shutdownRequested:  false,
};

// ─── Utilities ─────────────────────────────────────────────────────────────────
function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [AutoClick]`, ...args);
}

function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms) {
  if (ms <= 0) return '0ч 0м';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}ч ${m}м`;
}

// ─── Telegram Navigation ───────────────────────────────────────────────────────
// Главное меню
const BOT_COMMANDS = '/start — Показать меню\n/stop — Остановить\n/status — Статус\n/stats — Статистика\n/restart — Перезапустить';

const MAIN_KEYBOARD = [
  [{ text: '▶️ Запустить',    callback_data: 'start' }],
  [{ text: '⏹ Остановить',    callback_data: 'stop' }],
  [{ text: '📊 Статус',       callback_data: 'status' }],
  [{ text: '📈 Статистика',   callback_data: 'stats' }],
  [{ text: '🔄 Перезапустить', callback_data: 'restart' }],
  [{ text: '🖥️ Процессы',     callback_data: 'instances' }],
];

function getBrowserStatus() {
  if (state.browser && state.page) return '✅ Браузер работает';
  if (state.browser && !state.page) return '⚠️ Браузер открыт, страница не загружена';
  return '❌ Браузер закрыт';
}

function getRunStatus() {
  if (!state.isRunning) return '⏹ Остановлен';
  if (!state.browser || !state.page) return '⚠️ Ошибка (браузер не активен)';
  if (state.clickCount === 0 && state.isRunning) return '🔄 Запускается...';
  return '✅ Работает';
}

function getStatusText() {
  const elapsed = state.startTime && state.isRunning ? Date.now() - state.startTime : 0;
  const remaining = CONFIG.maxHours * 3600000 - elapsed;

  return (
    '🤖 <b>AutoClick</b>\n' +
    '━━━━━━━━━━━━━━\n' +
    `🔹 Статус: ${getRunStatus()}\n` +
    `🔹 ${getBrowserStatus()}\n` +
    `🔹 Кликов: ${state.clickCount}\n` +
    `━━━━━━━━━━━━━━\n` +
    `⏱ Прошло: ${formatDuration(elapsed)}\n` +
    `⏳ Осталось: ${elapsed > 0 ? formatDuration(Math.max(0, remaining)) : '—'}\n` +
    `⏰ Лимит: ${CONFIG.maxHours} часов`
  );
}

async function sendMainMenu(chatId, extraText, messageId) {
  let text = extraText ? extraText + '\n\n' : '';
  text += getStatusText();
  // Используем edit если есть явный messageId или сохранённый lastMenuMessageId
  const editId = messageId || state.lastMenuMessageId;
  if (editId) {
    await editTelegramMessage(chatId, editId, text, MAIN_KEYBOARD);
  } else {
    const newId = await sendTelegramMessage(chatId, text, MAIN_KEYBOARD);
    if (newId) { state.lastMenuMessageId = newId; saveSession(); }
  }
}

async function handleStart(chatId, messageId) {
  if (state.isRunning && state.browser && state.page) {
    await sendMainMenu(chatId, '⚠️ Учёт уже идёт', messageId);
    return;
  }
  if (state.startingUp) {
    await sendMainMenu(chatId, '⏳ Запуск уже выполняется...', messageId);
    return;
  }
  await sendMainMenu(chatId, '🔄 Запускаю браузер...', messageId);
  const startTargetId = messageId || state.lastMenuMessageId;
  startAutoClick().then(() => {
    const msg = (state.isRunning && state.browser) ? '✅ Учёт запущен' : '❌ Ошибка запуска';
    return sendMainMenu(chatId, msg, startTargetId);
  }).catch((err) => log('handleStart bg error:', err.message));
}

async function handleShowMenu(chatId, messageId) {
  const welcome = !state.isRunning
    ? '🤖 <b>AutoClick</b>\n\nСкрипт запущен и ждёт команды.\nНажмите <b>▶️ Запустить</b> чтобы начать учёт времени.\n\n' + BOT_COMMANDS
    : null;
  if (welcome) {
    const editId = messageId || state.lastMenuMessageId;
    if (editId) {
      await editTelegramMessage(chatId, editId, welcome, MAIN_KEYBOARD);
    } else {
      const newId = await sendTelegramMessage(chatId, welcome, MAIN_KEYBOARD);
      if (newId) { state.lastMenuMessageId = newId; saveSession(); }
    }
  } else {
    await sendMainMenu(chatId, null, messageId);
  }
}

async function handleStop(chatId, messageId) {
  if (!state.isRunning) {
    await sendMainMenu(chatId, '⚠️ Учёт не запущен', messageId);
    return;
  }
  await stopAutoClick();
  await sendMainMenu(chatId, '⏹ Учёт остановлен', messageId);
}

async function handleStatus(chatId, messageId) {
  await sendMainMenu(chatId, null, messageId);
}

async function handleKillPid(chatId, messageId, pid) {
  if (!pid || pid === process.pid) {
    await handleInstances(chatId, messageId);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err.code === 'ESRCH') {
      // Уже завершён — показываем актуальный список
      await handleInstances(chatId, messageId);
      return;
    }
    const editId = messageId || state.lastMenuMessageId;
    const text = `❌ Не удалось остановить PID ${pid}: ${err.message}`;
    const kb = [[{ text: '⬅️ Назад', callback_data: 'instances' }]];
    if (editId) await editTelegramMessage(chatId, editId, text, kb);
    return;
  }
  // Ждём завершения, при необходимости добиваем SIGKILL
  await new Promise(r => setTimeout(r, 1500));
  try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
  await new Promise(r => setTimeout(r, 500));
  await handleInstances(chatId, messageId);
}

async function handleKillOthers(chatId, messageId) {
  const { execSync } = require('child_process');
  let others = [];
  try {
    const out = execSync(
      "ps axo pid,comm | grep '[n]ode' | awk '{print $1}'",
      { encoding: 'utf8' }
    ).trim();
    const nodePids = out ? out.split('\n').map(Number).filter(Boolean) : [];
    others = nodePids.filter((pid) => {
      try {
        const args = execSync('ps -p ' + pid + ' -o args=', { encoding: 'utf8', timeout: 2000 }).trim();
        return args.includes('auto-click.js') && !args.includes('pgrep') && pid !== process.pid;
      } catch {
        return false;
      }
    });
  } catch {}
  for (const pid of others) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  await new Promise(r => setTimeout(r, 1500));
  for (const pid of others) {
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
  }
  await new Promise(r => setTimeout(r, 500));
  await handleInstances(chatId, messageId);
}

async function handleInstances(chatId, messageId) {
  const { execSync } = require('child_process');
  let pids = [];
  try {
    // Используем ps + grep вместо pgrep -f, чтобы исключить ложные
    // срабатывания на обёртке sh -c, которую execSync создаёт под капотом.
    // pgrep -f матчит sh -c pgrep ... потому что аргумент node.*auto-click.js
    // присутствует в командной строке shell-обёртки.
    const out = execSync(
      "ps axo pid,comm | grep '[n]ode' | awk '{print $1}'",
      { encoding: 'utf8' }
    ).trim();
    const nodePids = out ? out.split('\n').map(Number).filter(Boolean) : [];

    // Проверяем, какой из node-процессов действительно запущен с auto-click.js
    pids = nodePids.filter((pid) => {
      try {
        const args = execSync('ps -p ' + pid + ' -o args=', { encoding: 'utf8', timeout: 2000 }).trim();
        return args.includes('auto-click.js') && !args.includes('pgrep');
      } catch {
        return false;
      }
    });
  } catch {}

  const others = pids.filter(p => p !== process.pid);
  const editId = messageId || state.lastMenuMessageId;

  let text = `🖥️ <b>Экземпляры AutoClick</b>\n\n`;
  text += `▸ Текущий: PID <code>${process.pid}</code> (этот бот)\n`;

  if (others.length === 0) {
    text += '\n✅ Других экземпляров нет.';
    const kb = [[{ text: '⬅️ Меню', callback_data: 'menu' }]];
    if (editId) await editTelegramMessage(chatId, editId, text, kb);
    else { const n = await sendTelegramMessage(chatId, text, kb); if (n) { state.lastMenuMessageId = n; saveSession(); } }
    return;
  }

  text += `\n⚠️ Лишних экземпляров: <b>${others.length}</b>\n\n`;
  for (const pid of others) {
    try {
      const elapsed = execSync(`ps -p ${pid} -o etime= 2>/dev/null`, { encoding: 'utf8' }).trim();
      text += `• PID <code>${pid}</code> — работает ${elapsed}\n`;
    } catch {
      text += `• PID <code>${pid}</code>\n`;
    }
  }

  const keyboard = others.map(pid => [{ text: `❌ Убить PID ${pid}`, callback_data: `kill_${pid}` }]);
  if (others.length > 1) keyboard.push([{ text: '❌ Убить все лишние', callback_data: 'kill_all_others' }]);
  keyboard.push([{ text: '🔄 Обновить', callback_data: 'instances' }, { text: '⬅️ Меню', callback_data: 'menu' }]);

  if (editId) await editTelegramMessage(chatId, editId, text, keyboard);
  else { const n = await sendTelegramMessage(chatId, text, keyboard); if (n) { state.lastMenuMessageId = n; saveSession(); } }
}

async function handleRestart(chatId, messageId) {
  if (state.startingUp) {
    await sendMainMenu(chatId, '⏳ Уже перезапускается...', messageId);
    return;
  }
  await sendMainMenu(chatId, '🔄 Перезапускаю...', messageId);
  const restartTargetId = messageId || state.lastMenuMessageId;
  (async () => {
    await stopAutoClick();
    state.startTime = Date.now();
    state.clickCount = 0;
    await startAutoClick();
    const msg = state.isRunning ? '🔄 Учёт перезапущен' : '❌ Ошибка при перезапуске';
    await sendMainMenu(chatId, msg, restartTargetId);
  })().catch((err) => {
    log('handleRestart bg error:', err.message);
    sendMainMenu(chatId, '❌ Ошибка: ' + err.message, restartTargetId).catch(() => {});
  });
}

async function handleStats(chatId, messageId) {
  let text = '📈 <b>Статистика с сайта</b>\n\n';

  const reply = async (t, k) => {
    const editId = messageId || state.lastMenuMessageId;
    if (editId) {
      await editTelegramMessage(chatId, editId, t, k);
    } else {
      const newId = await sendTelegramMessage(chatId, t, k);
      if (newId) { state.lastMenuMessageId = newId; saveSession(); }
    }
  };

  if (!state.page) {
    text += '❌ Браузер не запущен.\nСначала нажмите <b>▶️ Запустить</b>';
    await reply(text, MAIN_KEYBOARD);
    return;
  }

  try {
    // SPA — клики меняют контент без смены URL, поэтому всегда возвращаемся на главную
    log('Stats: переход на главную для получения статистики');
    await state.page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle0', timeout: 20000 });
    await sleep(3000);

    // Проверка: не выкинуло ли на страницу логина (сессия истекла)
    const isLoggedIn = await checkLoggedIn(state.page);
    if (!isLoggedIn) {
      text += '⚠️ Сессия истекла. Статистика недоступна до перезапуска учёта.\n' +
              'Нажмите <b>🔄 Перезапустить</b> для входа заново.';
      await reply(text, MAIN_KEYBOARD);
      return;
    }

    // Ждём загрузки блока со временем (сайт может показывать "загружается" пока не придёт API-ответ)
    let dataReady = false;
    for (let i = 0; i < 12; i++) {
      const ready = await state.page.evaluate(() => {
        const t = document.body.innerText;
        return /сегодня[\s\S]{0,60}\d/i.test(t) || /за неделю[\s\S]{0,60}\d/i.test(t);
      }).catch(() => false);
      if (ready) { dataReady = true; break; }
      log('Stats: ожидание данных... попытка', i + 1);
      await sleep(2000);
    }

    if (!dataReady) {
      // Если данных всё ещё нет — возможно, страница не загрузилась или изменилась.
      // Показываем сырой текст для диагностики
      const rawText = await state.page.evaluate(() => {
        return (document.body.innerText || '').replace(/\s+/g, ' ').trim();
      }).catch(() => '—');
      log('Stats: данные не найдены, raw:', rawText.slice(0, 400));
      await takeScreenshot(state.page, 'stats_no_data');
      text += '⚠️ Данные статистики не обнаружены.\n\n<b>Текст страницы:</b>\n<code>';
      text += (rawText || '—').slice(0, 400) + '</code>';
      await reply(text, MAIN_KEYBOARD);
      return;
    }

    const data = await state.page.evaluate(() => {
      // Нормализуем все переносы строк в пробелы — иначе регулярки не матчатся через \n
      const raw = document.body.innerText.replace(/\s+/g, ' ').trim();
      const r = {};
      const m = (p) => { const x = raw.match(p); return x ? x[1].trim() : null; };
      const TIME = '(\\d+\\s*[чh][\\s:]*\\d+\\s*[мm]|\\d{1,2}:\\d{2})';
      const mTime = (...labels) => {
        for (const lbl of labels) {
          const re = new RegExp(lbl + '[^\\d]{0,15}' + TIME, 'i');
          const v = m(re);
          if (v) return v;
        }
        return null;
      };
      r.today  = mTime('сегодня', 'today');
      r.week   = mTime('за неделю', 'неделю', 'week');
      r.month  = mTime('за месяц', 'месяц', 'month');
      r.total  = mTime('всего', 'total');
      r.goal   = m(/цель[^\d\n]{0,15}([\d.]+\s*[чhm]?)/i);
      r.streak = m(/[Сс]трик[^\d\n]{0,5}(\d+\s*[дdД][а-яa-z]*)/i);
      r.avg    = mTime('в среднем', 'среднем', 'average');
      r.best   = mTime('лучший день', 'best');
      r.pct    = m(/(\d+)\s*%/);
      r.xp     = m(/([\d\s]+)\s*XP/);
      r.rank   = m(/#(\d+)\s*(из|of)\s*\d+/i);
      r.raw    = raw.slice(0, 600);
      return r;
    });

    log('Stats raw:', data.raw ? data.raw.slice(0, 400) : '—');

    const parts = [];
    if (data.today)  parts.push(`⏱ <b>Сегодня:</b> ${data.today}`);
    if (data.week)   parts.push(`📅 <b>За неделю:</b> ${data.week}`);
    if (data.month)  parts.push(`🗓 <b>За месяц:</b> ${data.month}`);
    if (data.total)  parts.push(`📦 <b>Всего:</b> ${data.total}`);
    if (data.goal)   parts.push(`🎯 <b>Цель:</b> ${data.goal}`);
    if (data.pct)    parts.push(`📈 <b>Выполнение:</b> ${data.pct}%`);
    if (data.streak) parts.push(`🔥 <b>Стрик:</b> ${data.streak}`);
    if (data.avg)    parts.push(`📊 <b>В среднем:</b> ${data.avg}`);
    if (data.best)   parts.push(`🏆 <b>Лучший день:</b> ${data.best}`);
    if (data.xp)     parts.push(`⭐ <b>XP:</b> ${data.xp.replace(/\s+/g, ' ')}`);
    if (data.rank)   parts.push(`🏅 <b>Ранг:</b> #${data.rank}`);

    if (parts.length > 0) {
      text += parts.join('\n');
    } else {
      text += '⚠️ Данные не распознаны.\n\n<b>Текст страницы:</b>\n<code>';
      text += (data.raw || '—').slice(0, 400) + '</code>';
    }
  } catch (err) {
    log('handleStats error:', err.message);
    text += '❌ Ошибка: ' + err.message;
  }

  await reply(text, MAIN_KEYBOARD);
}

// ─── Telegram API ──────────────────────────────────────────────────────────────
const TELEGRAM_API = `https://api.telegram.org/bot${CONFIG.telegramToken}`;

// Установка меню команд в Telegram (кнопка слева от ввода)
async function setupBotCommands() {
  if (!CONFIG.telegramToken) return;
  try {
    const commands = [
      { command: 'start',   description: 'Показать меню' },
      { command: 'stop',    description: 'Остановить учёт' },
      { command: 'status',  description: 'Текущий статус' },
      { command: 'stats',   description: 'Статистика с сайта' },
      { command: 'restart', description: 'Перезапустить' },
    ];
    await fetch(`${TELEGRAM_API}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    log('Меню команд Telegram установлено');
  } catch (err) {
    log('Ошибка установки меню команд:', err.message);
  }
}

async function sendTelegramMessage(chatId, text, keyboard) {
  if (!CONFIG.telegramToken || !chatId) return null;
  try {
    const body = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
    const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const r = await resp.json();
    return r.ok ? r.result.message_id : null;
  } catch (err) {
    log('Telegram send error:', err.message);
    return null;
  }
}

async function editTelegramMessage(chatId, messageId, text, keyboard) {
  if (!CONFIG.telegramToken || !chatId || !messageId) return;
  try {
    const body = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
    if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
    const resp = await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const r = await resp.json();
    if (!r.ok && r.description && !r.description.includes('not modified')) {
      log('Telegram edit warning:', r.description);
    }
  } catch (err) {
    log('Telegram edit error:', err.message);
  }
}

const MENU_KEYBOARD = MAIN_KEYBOARD;

async function answerCallbackQuery(callbackId, text) {
  if (!CONFIG.telegramToken || !callbackId) return;
  try {
    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: false }),
    });
  } catch (err) {
    log('Telegram answerCallbackQuery error:', err.message);
  }
}

async function pollTelegram() {
  if (!CONFIG.telegramToken || state.shutdownRequested) return;

  try {
    const params = new URLSearchParams({
      offset: state.telegramOffset,
      timeout: 25,
      limit: 10,
      allowed_updates: JSON.stringify(['message', 'callback_query']),
    });

    const resp = await fetch(`${TELEGRAM_API}/getUpdates?${params}`);
    const data = await resp.json();

    if (!data.ok) return;

    // Даже при пустом ответе сохраняем текущий offset — чтобы при перезапуске
    // не переигрывать старые команды
    saveOffset(state.telegramOffset);

    for (const update of data.result || []) {
      state.telegramOffset = update.update_id + 1;
      saveOffset(state.telegramOffset);

      // Игнорируем обновления старше 60 секунд (защита от дублей при перезапуске)
      const updateDate = update.message?.date || update.callback_query?.message?.date;
      if (updateDate && Date.now() / 1000 - updateDate > 60) continue;

      // Handle callback_query (inline button press)
      if (update.callback_query) {
        const cb = update.callback_query;
        const chatId = cb.message.chat.id;
        const cbData = cb.data;
        const callbackId = cb.id;
        const msgId = cb.message.message_id;

        if (!state.telegramChatId) {
          state.telegramChatId = chatId;
          saveSession();
        }

        log('Telegram callback:', cbData, 'from:', chatId);
        await answerCallbackQuery(callbackId, '⏳ Выполняю...');

        switch (cbData) {
          case 'start':     await handleStart(chatId, msgId); break;
          case 'stop':      await handleStop(chatId, msgId); break;
          case 'status':    await handleStatus(chatId, msgId); break;
          case 'stats':     await handleStats(chatId, msgId); break;
          case 'restart':   await handleRestart(chatId, msgId); break;
          case 'menu':      await handleShowMenu(chatId, msgId); break;
          case 'instances': await handleInstances(chatId, msgId); break;
          case 'kill_all_others': await handleKillOthers(chatId, msgId); break;
          default:
            if (cbData.startsWith('kill_')) {
              const pid = parseInt(cbData.slice(5));
              await handleKillPid(chatId, msgId, pid);
            }
        }
        continue;
      }

      // Handle text message
      const msg = update.message;
      if (!msg || !msg.text) continue;

      if (!state.telegramChatId) {
        state.telegramChatId = msg.chat.id;
        saveSession();
      }

      const text = msg.text.trim().toLowerCase();
      log('Telegram command:', text, 'from:', msg.chat.id);

      if (text === '/start' || text === 'start' || text === 'меню' || text === 'menu') {
        await handleShowMenu(msg.chat.id);
      } else if (text === '/stop' || text === 'stop' || text === '⏹ остановить') {
        await handleStop(msg.chat.id);
      } else if (text === '/status' || text === 'status' || text === '📊 статус') {
        await handleStatus(msg.chat.id);
      } else if (text === '/stats' || text === 'stats' || text === '📈 статистика' || text === '/statistic') {
        await handleStats(msg.chat.id);
      } else if (text === '/restart' || text === 'restart' || text === '🔄 перезапустить') {
        await handleRestart(msg.chat.id);
      } else if (text === '/menu' || text === 'menu' || text === '⚙️ меню') {
        await handleShowMenu(msg.chat.id);
      } else {
        // Любое сообщение — показываем меню с кнопками
        if (state.isRunning) {
          await sendMainMenu(msg.chat.id);
        } else {
          await sendTelegramMessage(msg.chat.id,
            '🤖 <b>AutoClick</b>\n\nСкрипт запущен и ждёт команды.\nНажмите <b>▶️ Запустить</b> чтобы начать учёт времени.\n\n' + BOT_COMMANDS,
            MAIN_KEYBOARD
          );
        }
      }
    }
  } catch (err) {
    log('Telegram poll error:', err.message);
  }
}

// ─── Telegram Polling Loop ─────────────────────────────────────────────────────
let telegramPollTimer = null;

async function startTelegramPolling() {
  if (!CONFIG.telegramToken) {
    log('Telegram токен не указан — управление через бота недоступно');
    return;
  }

  log('⏸ Режим ожидания. Напишите боту /start чтобы запустить');
  log('Telegram polling запущен. Бот: @OlzhtomBot');

  // Если уже знаем chatId — редактируем последнее меню или шлём новое
  if (state.telegramChatId) {
    const msg =
      '🤖 <b>AutoClick</b> запущен и ждёт команды.\n\n' +
      'Нажмите <b>▶️ Запустить</b> чтобы начать учёт времени.\n' +
      'Настройки: ' + CONFIG.maxHours + ' часов, интервал ' + CONFIG.minIntervalMin + '-' + CONFIG.maxIntervalMin + ' мин.';
    if (state.lastMenuMessageId) {
      await editTelegramMessage(state.telegramChatId, state.lastMenuMessageId, msg, MENU_KEYBOARD);
    } else {
      const newId = await sendTelegramMessage(state.telegramChatId, msg, MENU_KEYBOARD);
      if (newId) { state.lastMenuMessageId = newId; saveSession(); }
    }
  }

  const poll = async () => {
    await pollTelegram();
    if (!state.shutdownRequested) {
      telegramPollTimer = setTimeout(poll, 3000);
    }
  };
  await poll();
}

function stopTelegramPolling() {
  if (telegramPollTimer) {
    clearTimeout(telegramPollTimer);
    telegramPollTimer = null;
  }
}

// ─── Telegram Notification Helper ──────────────────────────────────────────────
async function notifyTelegram(text) {
  if (state.telegramChatId) {
    await sendTelegramMessage(state.telegramChatId, text + '\n\n— — —\n⚙️ /menu — управление');
  }
}

// ─── Screenshot on Error ────────────────────────────────────────────────────────
const SCREENSHOT_DIR = path.join(__dirname, '.screenshots');

async function takeScreenshot(page, label) {
  try {
    if (!page) return;
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const filename = `${Date.now()}_${label}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: false });
    log(`📸 Скриншот сохранён: ${filename}`);
    return filepath;
  } catch (err) {
    log('Ошибка скриншота:', err.message);
  }
}

// ─── Puppeteer — Browser ───────────────────────────────────────────────────────
async function launchBrowser() {
  const puppeteer = require('puppeteer');

  const browser = await puppeteer.launch({
    headless: CONFIG.headless ? 'new' : false,
    slowMo: CONFIG.slowMo,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,800',
    ],
  });

  state.browser = browser;
  log('Браузер запущен');

  // Grant geolocation permission for target URL
  const context = browser.defaultBrowserContext();
  await context.overridePermissions(CONFIG.targetUrl, ['geolocation']);
  log('Разрешение геолокации выдано для:', CONFIG.targetUrl);

  return browser;
}

// ─── Puppeteer — Page Setup ────────────────────────────────────────────────────
async function setupPage(page) {
  // Override geolocation via CDP (works after permission is granted)
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setGeolocationOverride', {
    latitude: CONFIG.latitude,
    longitude: CONFIG.longitude,
    accuracy: CONFIG.accuracy,
  });
  log('Геолокация подменена: ' + CONFIG.latitude + ', ' + CONFIG.longitude);

  // Set viewport
  await page.setViewport({ width: 1280, height: 800 });

  // Handle dialogs automatically
  page.on('dialog', async (dialog) => {
    log('Диалог:', dialog.message());
    await dialog.accept();
  });

  // Log console messages from page
  page.on('console', (msg) => {
    if (msg.text().includes('[AutoClick]')) {
      log('[Page]', msg.text());
    }
  });

  // Detect login redirects
  page.on('response', (resp) => {
    if (resp.url().includes('/login') && resp.status() === 200) {
      log('Страница логина обнаружена');
    }
  });
}

// ─── Authentication ────────────────────────────────────────────────────────────
async function login(page) {
  log('Проверка авторизации...');
  await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle0', timeout: 30000 });

  // Wait for page to render (React SPA)
  await sleep(5000);

  // Check if already logged in — look for dashboard elements
  const isLoggedIn = await checkLoggedIn(page);
  if (isLoggedIn) {
    log('Уже авторизован');
    return true;
  }

  log('Форма входа: OAuth через Gitea + 01-platform. Запуск авторизации...');

  // ── Step 1: Click "Войти через Gitea" ──
  // Пробуем до 3 раз с разными стратегиями
  let giteaNavigated = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const urlBefore = page.url();
    const giteaClicked = await clickButtonByText(page, ['Gitea']);
    if (!giteaClicked) {
      if (attempt === 3) {
        await takeScreenshot(page, 'gitea_not_found');
        throw new Error('Кнопка "Войти через Gitea" не найдена на ' + page.url());
      }
      log('Gitea не найдена, попытка ' + attempt + ': пробуем другие селекторы...');
      // Альтернатива: поиск по href или aria-label
      const altClicked = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="gitea"], a[href*="oauth"], a[href*="login"], button[aria-label*="Gitea"]');
        for (const el of links) {
          if (el.offsetParent !== null) { el.click(); return true; }
        }
        return false;
      }).catch(() => false);
      if (!altClicked) continue;
    }
    log('Клик: Войти через Gitea (попытка ' + attempt + ')');
    await sleep(2000);
    await waitForNavigation(page, 10000);

    // Проверяем, изменился ли URL
    const urlAfter = page.url();
    if (urlAfter !== urlBefore && !urlAfter.includes('dashboard')) {
      giteaNavigated = true;
      break;
    }
    log('Навигация не произошла, повтор...');
  }
  await sleep(2000);

  if (!giteaNavigated) {
    await takeScreenshot(page, 'gitea_no_navigation');
    // Пробуем прямой переход на страницу логина 01-platform (Gitea SSO)
    log('Gitea: пробуем прямой переход на страницу авторизации 01...');
    await page.goto('https://auth.tomorrow-school.ai/oauth/authorize', { waitUntil: 'networkidle0', timeout: 15000 }).catch(() => {});
    await sleep(3000);
  }

  // ── Step 2: Click "Sign in with 01-platform" on Gitea ──
  let oauthNavigated = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const urlBefore = page.url();
    const oauthClicked = await clickButtonByText(page, ['01-platform', '01 platform', '01platform', 'SSO']);
    if (!oauthClicked) {
      if (attempt === 3) {
        await takeScreenshot(page, 'oauth_btn_not_found');
        throw new Error('Кнопка "Sign in with 01-platform" не найдена на ' + page.url());
      }
      log('01-platform не найдена, попытка ' + attempt + ': пробуем прямую ссылку...');
      // Пробуем найти ссылку с oauth/casdoor/openid в href
      const altClicked = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="oauth"], a[href*="casdoor"], a[href*="openid"], a[href*="01"], a[href*="authorize"]');
        for (const el of links) {
          if (el.offsetParent !== null) { el.click(); return true; }
        }
        return false;
      }).catch(() => false);
      if (!altClicked) continue;
    }
    log('Клик: Sign in with 01-platform (попытка ' + attempt + ')');
    await sleep(3000);
    await waitForNavigation(page, 15000);

    const urlAfter = page.url();
    if (urlAfter !== urlBefore) {
      oauthNavigated = true;
      break;
    }
    log('01-platform: навигация не произошла, повтор...');
  }
  await sleep(2000);

  // ── Step 3: Fill login form on 01-platform ──
  log('Форма логина 01-platform. Заполнение...');

  // Возможный сценарий: SSO-провайдер уже имел активную сессию и сразу
  // перекинул обратно на dashboard. Проверяем, не авторизованы ли уже.
  const ssoAutoLoggedIn = await checkLoggedIn(page);
  if (ssoAutoLoggedIn) {
    log('SSO: уже аутентифицирован (авто-редирект)');
    await notifyTelegram('🔓 Успешный вход в систему (SSO)');
    return true;
  }

  // Use known selectors from login page
  let emailInput = await page.$('#email-field') || await page.$('input[name="email"]');
  let passwordInput = await page.$('#password-field') || await page.$('input[name="password"]');

  if (!emailInput || !passwordInput) {
    // Fallback: try generic detection
    const inputs = await page.$$('input');
    log('Найдено input элементов:', inputs.length, 'на', page.url());
    if (inputs.length >= 2) {
      emailInput = inputs[0];
      passwordInput = inputs[1];
    } else {
      throw new Error(
        'Не удалось найти поля входа на 01-platform.\n' +
        'Страница: ' + page.url()
      );
    }
  }

  // Fill credentials
  await emailInput.click({ clickCount: 3 });
  await emailInput.type(CONFIG.email, { delay: 50 });
  log('Email введён');

  await passwordInput.click({ clickCount: 3 });
  await passwordInput.type(CONFIG.password, { delay: 30 });
  log('Пароль введён');

  // Submit
  const submitBtn = await page.$('button[type="submit"]') ||
                     await page.$('button:has-text("Login")') ||
                     await page.$('#login-form button');

  if (submitBtn) {
    await submitBtn.click();
    log('Клик по кнопке Login');
  } else {
    await page.keyboard.press('Enter');
    log('Отправка формы через Enter');
  }

  // ── Step 4: Wait for OAuth redirect back to dashboard ──
  log('Ожидание редиректа после логина...');
  await sleep(5000);
  for (let i = 0; i < 8; i++) {
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 });
    } catch { /* continue waiting */ }
    await sleep(3000);
    const url = page.url();
    log('URL:', url.substring(0, 80));

    if (url.includes('dashboard')) break;
    const loggedIn = await checkLoggedIn(page);
    if (loggedIn) break;
  }

  await sleep(5000);

  // Wait for dashboard to fully render (menu buttons)
  log('Ожидание загрузки дашборда...');
  for (let i = 0; i < 10; i++) {
    const hasMenu = await page.evaluate(() => {
      const texts = ['Leaderboard', 'Маркетплейс', 'Профиль', 'Главная'];
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        for (const t of texts) {
          if (btn.textContent.trim().includes(t)) return true;
        }
      }
      return false;
    }).catch(() => false);
    if (hasMenu) { log('Дашборд загружен'); break; }
    log('Ожидание...');
    await sleep(3000);
  }

  // Start time tracking if not already running
  log('Проверка статуса учёта времени...');
  const trackingStarted = await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      const text = btn.textContent.trim().toLowerCase();
      // Если кнопка says "Запустить учёт" или "Начать учёт" — кликаем
      if (text.includes('запустить') || text.includes('начать') || text.includes('start') || text.includes('запуск')) {
        btn.click();
        return 'started';
      }
    }
    return 'already_running';
  });

  if (trackingStarted === 'started') {
    log('Учёт времени запущен');
  } else {
    log('Учёт времени уже активен');
  }

  // Verify login
  const loggedIn = await checkLoggedIn(page);
  if (loggedIn) {
    log('Авторизация успешна');
    await notifyTelegram('🔓 Успешный вход в систему');
    return true;
  }

  throw new Error('Не удалось авторизоваться. Проверьте EMAIL/PASSWORD');
}

// Helper: click button by text content
async function clickButtonByText(page, texts) {
  return await page.evaluate((searchTexts) => {
    const allButtons = document.querySelectorAll('button, a');
    for (const el of allButtons) {
      const t = el.textContent.trim().toLowerCase();
      for (const search of searchTexts) {
        if (t.includes(search.toLowerCase())) {
          el.click();
          return true;
        }
      }
    }
    return false;
  }, texts);
}

// Helper: wait for navigation safely
async function waitForNavigation(page, timeoutMs) {
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: timeoutMs });
  } catch {
    /* navigation may happen via SPA */
  }
}

// ─── Session Check ─────────────────────────────────────────────────────────────
async function checkLoggedIn(page) {
  try {
    // Check for dashboard menu buttons (only appear after auth)
    const hasDashboardButtons = await page.evaluate(() => {
      const menuTexts = ['Leaderboard', 'Маркетплейс', 'Профиль', 'Главная'];
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const t = btn.textContent.trim();
        for (const m of menuTexts) {
          if (t.includes(m)) return true;
        }
      }
      return false;
    }).catch(() => false);

    if (hasDashboardButtons) return true;

    // Check for welcome/login page indicators
    const isWelcomePage = await page.evaluate(() => {
      const body = document.body;
      if (!body) return false;
      const text = body.innerText;
      return text.includes('Gitea') || text.includes('Войти через') || 
             text.includes('Welcome to Tomorrow School') || text.includes('Create an account');
    }).catch(() => false);

    if (isWelcomePage) return false;

    // Fallback: if on dashboard URL and no login form visible
    const url = page.url();
    const hasLoginForm = await page.$('input[type="password"], #email-field, #password-field');
    if (url.includes('dashboard') && !hasLoginForm) {
      // Double-check: look for dashboard-specific content
      const hasDashboardContent = await page.evaluate(() => {
        const body = document.body;
        if (!body) return false;
        return body.innerText.includes('XP') || body.innerText.includes('Уровень') || 
               body.innerText.includes('Ранг') || body.innerText.includes('WORKSPACE');
      }).catch(() => false);
      return hasDashboardContent;
    }

    return false;
  } catch {
    return false;
  }
}

// ─── Tracking Start ────────────────────────────────────────────────────────────
async function ensureTrackingActive(page) {
  try {
    const result = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const text = btn.textContent.trim().toLowerCase();
        // If tracking hasn't started yet — start it
        if (text.includes('запустить') || text.includes('начать') || text.includes('запуск') || text.includes('start учёт')) {
          btn.click();
          return 'started';
        }
      }
      return 'already_active';
    });

    if (result === 'started') {
      log('Учёт времени запущен');
      await sleep(2000);
    }
  } catch (err) {
    log('Ошибка при запуске учёта:', err.message);
  }
}

// ─── Activity Simulation ───────────────────────────────────────────────────────
const MENU_TEXTS = ['Leaderboard', 'Маркетплейс', 'Профиль', 'Главная'];

async function waitForDashboard(page) {
  for (let i = 0; i < 15; i++) {
    const ready = await page.evaluate((texts) => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        for (const t of texts) {
          if (btn.textContent.trim().includes(t)) return true;
        }
      }
      return false;
    }, MENU_TEXTS).catch(() => false);

    if (ready) return true;
    await sleep(2000);
  }
  return false;
}

async function performActivity(page) {
  log('Выполнение активности...');

  // Ensure dashboard is loaded before activity
  const dashboardReady = await waitForDashboard(page);
  if (!dashboardReady) {
    log('Дашборд не загрузился, попытка активности вслепую');
  }

  try {
    // 1. Scroll
    const scrollAmount = getRandomInt(200, 400);
    await page.evaluate((amount) => {
      window.scrollBy({ top: amount, behavior: 'smooth' });
    }, scrollAmount);
    log('Скролл вниз:', scrollAmount + 'px');
    await sleep(getRandomInt(800, 1500));

    // 2. Find menu buttons
    const buttons = await page.evaluate((texts) => {
      const allBtns = document.querySelectorAll('button');
      const results = [];
      for (const btn of allBtns) {
        const trimmed = btn.textContent.trim();
        for (const text of texts) {
          if (trimmed.includes(text)) {
            results.push({ index: [...allBtns].indexOf(btn), text: trimmed });
            break;
          }
        }
      }
      return results;
    }, MENU_TEXTS);

    if (buttons.length === 0) {
      log('Кнопки меню не найдены, скролл вверх');
      const scrollUp = getRandomInt(100, 200);
      await page.evaluate((amount) => {
        window.scrollBy({ top: -amount, behavior: 'smooth' });
      }, scrollUp);
      await sleep(1000);
      state.clickCount++;
      return { success: true, action: 'scrolled_only' };
    }

    // Pick random button
    const target = buttons[getRandomInt(0, buttons.length - 1)];
    log('Цель:', target.text);

    // 3. Hover over it
    const elements = await page.$$('button');
    const targetEl = elements[target.index];
    if (targetEl) {
      await targetEl.hover();
      log('Hover на:', target.text);
      await sleep(getRandomInt(500, 1500));

      // 4. Click
      await targetEl.click();
      log('Клик на:', target.text);
    }

    state.clickCount++;
    log('Активность выполнена. Всего кликов:', state.clickCount);
    return { success: true, action: 'clicked', buttonText: target.text };
  } catch (err) {
    log('Ошибка активности:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── Session Monitor ───────────────────────────────────────────────────────────
async function checkSession(page) {
  try {
    const loggedIn = await checkLoggedIn(page);
    if (!loggedIn) {
      log('Сессия потеряна! Повторная авторизация...');
      await notifyTelegram('⚠️ Сессия потеряна, выполняю повторный вход');
      return await login(page);
    }
    return true;
  } catch (err) {
    log('Ошибка проверки сессии:', err.message);
    return false;
  }
}

// ─── Main Loop ─────────────────────────────────────────────────────────────────
async function activityLoop(page) {
  const maxMs = CONFIG.maxHours * 3600000;

  while (!state.shutdownRequested && state.isRunning) {
    // Check 10-hour limit
    if (state.startTime) {
      const elapsed = Date.now() - state.startTime;
      if (elapsed >= maxMs) {
        log('Достигнут лимит в ' + CONFIG.maxHours + ' часов');
        await notifyTelegram('✅ ' + CONFIG.maxHours + ' часов истекло. AutoClick завершён');
        await stopAutoClick();
        return;
      }
    }

    // Check session
    const sessionOk = await checkSession(page);
    if (!sessionOk) {
      log('Не удалось восстановить сессию. Остановка.');
      await notifyTelegram('❌ Ошибка: не удалось восстановить сессию');
      await stopAutoClick();
      return;
    }

    // Ensure time tracking is active
    await ensureTrackingActive(page);

    // Perform activity
    await performActivity(page);

    // Calculate next interval (5-12 min)
    const intervalMin = getRandomInt(CONFIG.minIntervalMin, CONFIG.maxIntervalMin);
    const intervalMs = intervalMin * 60 * 1000;
    const nextTime = new Date(Date.now() + intervalMs);
    log('Следующая активность в', nextTime.toLocaleTimeString(), '(через ' + intervalMin + ' мин)');

    // Wait for next interval (checking shutdown flag every second)
    const checkInterval = 1000;
    let waited = 0;
    while (waited < intervalMs && !state.shutdownRequested && state.isRunning) {
      await sleep(checkInterval);
      waited += checkInterval;
    }
  }
}

// ─── Start / Stop ──────────────────────────────────────────────────────────────
async function startAutoClick() {
  if (state.startingUp) return;

  // Если уже запущен — проверяем, жив ли браузер
  if (state.isRunning) {
    if (state.browser && state.page) {
      return; // Всё ок, уже работает
    }
    // Браузер умер — сбрасываем и запускаем заново
    log('Браузер не активен, перезапуск...');
    state.isRunning = false;
    state.startTime = null;
    if (state.browser) {
      try { await state.browser.close(); } catch {}
      state.browser = null;
    }
    state.page = null;
  }

  state.startingUp = true;
  state.isRunning = true;
  state.startTime = Date.now();

  log('═══════════════════════════════════════');
  log('AutoClick ЗАПУЩЕН');
  log('  Лимит:', CONFIG.maxHours + ' часов');
  log('  Интервал:', CONFIG.minIntervalMin + '-' + CONFIG.maxIntervalMin + ' мин');
  log('  Цель:', CONFIG.targetUrl);
  if (CONFIG.telegramToken) {
    log('  Telegram: активен');
  }
  log('═══════════════════════════════════════');

  try {
    // Launch browser
    if (!state.browser) {
      await launchBrowser();
    }

    const page = state.page || await state.browser.newPage();
    state.page = page;
    await setupPage(page);

    // Login
    await login(page);

    // Start activity loop (non-blocking)
    state.activityPromise = activityLoop(page).catch((err) => {
      log('activityLoop завершён:', err.message);
      if (state.isRunning) {
        state.isRunning = false;
        notifyTelegram('❌ Критическая ошибка активности: ' + err.message).catch(() => {});
      }
    });
  } catch (err) {
    log('Ошибка запуска:', err.message);
    // Скриншот при ошибке запуска для диагностики
    await takeScreenshot(state.page, 'start_error');
    if (state.isRunning) {
      await notifyTelegram('❌ Ошибка запуска: ' + err.message);
    }
    state.isRunning = false;
    state.startTime = null;
    if (state.browser) {
      try { await state.browser.close(); } catch {}
      state.browser = null;
    }
    state.page = null;
  } finally {
    state.startingUp = false;
  }
}

async function stopAutoClick() {
  state.isRunning = false;
  state.activityPromise = null;
  if (state.browser) {
    try { await state.browser.close(); } catch {}
    state.browser = null;
    state.page = null;
  }
  log('AutoClick остановлен');
}

async function sendStartupMenu() {
  if (!state.telegramChatId || !CONFIG.telegramToken) return;
  const text = '🔄 <b>AutoClick перезапущен</b>\n\n' + getStatusText();
  const newId = await sendTelegramMessage(state.telegramChatId, text, MAIN_KEYBOARD);
  if (newId) { state.lastMenuMessageId = newId; saveSession(); }
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────
async function shutdown() {
  if (state.shutdownRequested) return;
  state.shutdownRequested = true;

  log('Завершение работы...');
  stopTelegramPolling();

  if (state.isRunning) {
    await notifyTelegram('⏹ Сервер остановлен');
  }

  if (state.browser) {
    try {
      await state.browser.close();
      log('Браузер закрыт');
    } catch (err) {
      log('Ошибка закрытия браузера:', err.message);
    }
  }

  log('До свидания!');
  process.exit(0);
}

// ─── Initialization ────────────────────────────────────────────────────────────
async function main() {
  log('AutoClick v2.0.0 — Запуск...');
  log('Node.js:', process.version);

  // Validate config
  if (!CONFIG.email || !CONFIG.password || !CONFIG.telegramToken) {
    console.error('Ошибка: EMAIL, PASSWORD и TELEGRAM_TOKEN обязательны');
    console.error('  EMAIL=your@email.com PASSWORD=your_pass TELEGRAM_TOKEN=токен node auto-click.js');
    console.error('  Или создайте .env файл (см. .env.example)');
    process.exit(1);
  }

  // Set up signal handlers
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    log('Непредвиденная ошибка:', err.message);
    shutdown();
  });

  // Настраиваем меню команд в Telegram (кнопка слева от ввода)
  await setupBotCommands();

  // Если AUTO_START=true — запускаем автоклик сразу без команды из Telegram
  if (process.env.AUTO_START === 'true') {
    log('AUTO_START: запуск автоклика без команды Telegram...');
    startTelegramPolling();
    await sendStartupMenu();
    await startAutoClick();
  } else {
    // Ждём команду /start из Telegram — сами ничего не запускаем
    startTelegramPolling();
    await sendStartupMenu();
  }

  // Keep process alive
  await new Promise(() => {});
}

// ─── Entry Point ───────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
