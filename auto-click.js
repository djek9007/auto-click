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
const os   = require('os');

function detectMachineName() {
  if (process.env.MACHINE_NAME) return process.env.MACHINE_NAME;
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'darwin') {
      return execSync('scutil --get ComputerName', { encoding: 'utf8', timeout: 3000 }).trim();
    } else if (process.platform === 'linux') {
      return execSync('hostname', { encoding: 'utf8', timeout: 3000 }).trim();
    } else if (process.platform === 'win32') {
      return process.env.COMPUTERNAME || os.hostname();
    }
  } catch {}
  return os.hostname();
}

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

  // Multi-machine coordination
  machineName:     detectMachineName(),
  gistId:          process.env.GIST_ID || '',
  githubToken:     process.env.GITHUB_TOKEN || '',
  configGistId:    process.env.CONFIG_GIST_ID || '',

  // School coordinates for geolocation override
  latitude:        51.089159,
  longitude:       71.415595,
  accuracy:        10,
};

// ─── Remote Config Loading ────────────────────────────────────────────────────
async function loadRemoteConfig() {
  if (!CONFIG.configGistId) return;

  try {
    // Config gist is public-readable — no auth needed
    const resp = await fetch(`https://api.github.com/gists/${CONFIG.configGistId}`, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) { log('Remote config: HTTP', resp.status); return; }
    const data = await resp.json();
    const file = data.files && data.files['config.json'];
    if (!file) { log('Remote config: config.json not found in Gist'); return; }

    const remote = JSON.parse(file.content);
    log('Remote config загружен из Gist');
    log('Remote keys:', Object.keys(remote).join(', '));

    // Apply remote values — local .env takes priority
    if (!process.env.EMAIL && remote.EMAIL) { CONFIG.email = remote.EMAIL; log('  + EMAIL from Gist'); }
    if (!process.env.PASSWORD && remote.PASSWORD) { CONFIG.password = remote.PASSWORD; log('  + PASSWORD from Gist'); }
    if (!process.env.TELEGRAM_TOKEN && remote.TELEGRAM_TOKEN) { CONFIG.telegramToken = remote.TELEGRAM_TOKEN; log('  + TELEGRAM_TOKEN from Gist'); }
    if (!process.env.TARGET_URL && remote.TARGET_URL) CONFIG.targetUrl = remote.TARGET_URL;
    if (!process.env.MAX_HOURS && remote.MAX_HOURS) CONFIG.maxHours = parseInt(remote.MAX_HOURS, 10);
    if (!process.env.MIN_INTERVAL_MIN && remote.MIN_INTERVAL_MIN) CONFIG.minIntervalMin = parseInt(remote.MIN_INTERVAL_MIN, 10);
    if (!process.env.MAX_INTERVAL_MIN && remote.MAX_INTERVAL_MIN) CONFIG.maxIntervalMin = parseInt(remote.MAX_INTERVAL_MIN, 10);
    if (!process.env.HEADLESS && remote.HEADLESS) CONFIG.headless = remote.HEADLESS !== 'false';
    if (!process.env.SLOW_MO && remote.SLOW_MO) CONFIG.slowMo = parseInt(remote.SLOW_MO, 10);
    if (!process.env.GIST_ID && remote.GIST_ID) { CONFIG.gistId = remote.GIST_ID; log('  + GIST_ID from Gist:', remote.GIST_ID); }
    log('After remote: email=', !!CONFIG.email, 'token=', !!CONFIG.telegramToken, 'gistId=', CONFIG.gistId || 'empty');
  } catch (err) {
    log('Remote config error:', err.message);
  }
}

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
  nextClickTime:      null,
  machineRole:        'standby',
  gistCheckTimer:     null,
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

// ─── GitHub Gist — Multi-Machine Coordination ────────────────────────────────
async function gistFetch(url, options = {}) {
  if (!CONFIG.githubToken) return null;
  try {
    const resp = await fetchWithTimeout(url, {
      ...options,
      headers: {
        'Authorization': `token ${CONFIG.githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        ...(options.headers || {}),
      },
      timeout: 10000,
    });
    return resp;
  } catch (err) {
    log('Gist fetch error:', err.message);
    return null;
  }
}

async function readGist() {
  if (!CONFIG.gistId) return null;
  const resp = await gistFetch(`https://api.github.com/gists/${CONFIG.gistId}`);
  if (!resp) return null;
  try {
    const data = await resp.json();
    if (!data.files || !data.files['machine-lock.json']) return null;
    return JSON.parse(data.files['machine-lock.json'].content);
  } catch (err) {
    log('Gist parse error:', err.message);
    return null;
  }
}

async function writeGist(data) {
  if (!CONFIG.gistId) return false;
  const resp = await gistFetch(`https://api.github.com/gists/${CONFIG.gistId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: { 'machine-lock.json': { content: JSON.stringify(data, null, 2) } },
    }),
  });
  if (!resp) return false;
  try {
    const r = await resp.json();
    return !!r.id;
  } catch { return false; }
}

async function registerMachine() {
  if (!CONFIG.gistId) return;
  const lock = await readGist() || { active: null, telegramOffset: 0, machines: {} };
  if (!lock.machines) lock.machines = {};
  lock.machines[CONFIG.machineName] = {
    lastSeen: new Date().toISOString(),
    status: 'standby',
    email: CONFIG.email || '',
  };
  await writeGist(lock);
  log(`Машина ${CONFIG.machineName} зарегистрирована в Gist`);
}

async function heartbeat() {
  if (!CONFIG.gistId) return;
  try {
    const lock = await readGist();
    if (!lock) return;
    if (!lock.machines) lock.machines = {};
    const entry = lock.machines[CONFIG.machineName] || {};
    entry.lastSeen = new Date().toISOString();
    entry.email = CONFIG.email || '';
    if (entry.status !== 'active') entry.status = 'standby';
    lock.machines[CONFIG.machineName] = entry;
    await writeGist(lock);
  } catch (err) {
    log('Heartbeat error:', err.message);
  }
}

async function claimActive() {
  if (!CONFIG.gistId) return false;
  const lock = await readGist();
  if (!lock) return false;
  lock.active = CONFIG.machineName;
  lock.telegramOffset = state.telegramOffset;
  if (!lock.machines) lock.machines = {};
  lock.machines[CONFIG.machineName] = {
    lastSeen: new Date().toISOString(),
    status: 'active',
    email: CONFIG.email || '',
  };
  await writeGist(lock);
  return true;
}

async function releaseActive() {
  if (!CONFIG.gistId) return;
  try {
    const lock = await readGist();
    if (!lock) return;
    if (lock.active === CONFIG.machineName) {
      lock.active = null;
    }
    if (lock.machines && lock.machines[CONFIG.machineName]) {
      lock.machines[CONFIG.machineName].status = 'standby';
      lock.machines[CONFIG.machineName].lastSeen = new Date().toISOString();
    }
    lock.telegramOffset = state.telegramOffset;
    await writeGist(lock);
  } catch (err) {
    log('releaseActive error:', err.message);
  }
}

async function getActiveMachineName() {
  if (!CONFIG.gistId) return CONFIG.machineName;
  try {
    const lock = await readGist();
    if (lock && lock.active) return lock.active;
  } catch {}
  return 'неизвестно';
}

function startGistWatcher() {
  if (state.gistCheckTimer) clearInterval(state.gistCheckTimer);
  state.gistCheckTimer = setInterval(async () => {
    try {
      // Heartbeat first to update our lastSeen without overwriting other changes
      await heartbeat();
      const lock = await readGist();
      if (!lock) return;
      if (lock.active === CONFIG.machineName && state.machineRole !== 'active') {
        log('Эта машина назначена активной! Переключение...');
        state.machineRole = 'active';
        state.telegramOffset = lock.telegramOffset || 0;
        saveOffset(state.telegramOffset);
        clearInterval(state.gistCheckTimer);
        state.gistCheckTimer = null;
        startTelegramPolling();
        await sendStartupMenu();
        if (process.env.AUTO_START === 'true') {
          await startAutoClick();
        }
      }
    } catch (err) {
      log('Gist check error:', err.message);
    }
  }, 30000);
}

// ─── Telegram Navigation ───────────────────────────────────────────────────────
// Главное меню
const BOT_COMMANDS = '/start — Показать меню\n/stop — Остановить\n/status — Статус\n/stats — Статистика\n/machines — Машины\n/restart — Перезапустить\n/update — Обновить код\n/help — Справка';

function getKeyboard() {
  if (state.isRunning) {
    return [
      [{ text: '⏹ Остановить учёт',    callback_data: 'stop' }],
      [{ text: '📊 Обновить статус',    callback_data: 'status' }, { text: '📈 Статистика с сайта', callback_data: 'stats' }],
      [{ text: '🔄 Перезапустить',     callback_data: 'restart' }, { text: '🖥️ Активные процессы', callback_data: 'instances' }],
      [{ text: '🔽 Обновить код',      callback_data: 'update_code' }, { text: '❓ Помощь', callback_data: 'help' }],
    ];
  } else {
    return [
      [{ text: '▶️ Запустить учёт',    callback_data: 'start' }],
      [{ text: '📊 Обновить статус',    callback_data: 'status' }],
      [{ text: '🖥️ Активные процессы', callback_data: 'instances' }, { text: '🔽 Обновить код', callback_data: 'update_code' }],
      [{ text: '❓ Помощь',            callback_data: 'help' }],
    ];
  }
}

function isPageValid() {
  try {
    return state.page && !state.page.isClosed();
  } catch {
    return false;
  }
}

function getBrowserStatus() {
  if (state.browser && isPageValid()) return '✅ Браузер работает';
  if (state.browser && !isPageValid()) return '⚠️ Браузер открыт, страница не загружена';
  return '❌ Браузер закрыт';
}

function getRunStatus() {
  if (!state.isRunning) return '⏹ Остановлен';
  if (!state.browser || !isPageValid()) return '⚠️ Ошибка (браузер не активен)';
  if (state.clickCount === 0 && state.isRunning) return '🔄 Запускается...';
  return '✅ Работает';
}

function getStatusText() {
  const elapsed = state.startTime && state.isRunning ? Date.now() - state.startTime : 0;
  const remaining = CONFIG.maxHours * 3600000 - elapsed;
  const roleLabel = state.machineRole === 'active' ? 'Активна' : 'Ожидание';

  return (
    `🖥️ <b>${CONFIG.machineName}</b> (${roleLabel})\n` +
    '🤖 <b>AutoClick</b>\n' +
    '━━━━━━━━━━━━━━\n' +
    `🔹 Статус: ${getRunStatus()}\n` +
    `🔹 ${getBrowserStatus()}\n` +
    `🔹 Кликов: ${state.clickCount}\n` +
    `🔹 Следующий клик: ${state.nextClickTime ? state.nextClickTime.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'}\n` +
    `━━━━━━━━━━━━━━\n` +
    `⏱ Прошло: ${formatDuration(elapsed)}\n` +
    `⏳ Осталось: ${elapsed > 0 ? formatDuration(Math.max(0, remaining)) : '—'}\n` +
    `⏰ Лимит: ${CONFIG.maxHours} часов`
  );
}

async function sendMainMenu(chatId, extraText, messageId) {
  let text = extraText ? extraText + '\n\n' : '';
  text += getStatusText();
  
  if (messageId) {
    const success = await editTelegramMessage(chatId, messageId, text, getKeyboard());
    if (success) {
      state.lastMenuMessageId = messageId;
      saveSession();
      return;
    }
  }
  
  if (state.lastMenuMessageId) {
    await deleteTelegramMessage(chatId, state.lastMenuMessageId).catch(() => {});
    state.lastMenuMessageId = null;
  }
  
  const newId = await sendTelegramMessage(chatId, text, getKeyboard());
  if (newId) { state.lastMenuMessageId = newId; saveSession(); }
}

async function handleStart(chatId, messageId) {
  // Проверка: машина в режиме standby
  if (state.machineRole !== 'active') {
    const text = `⚠️ Эта машина в режиме ожидания.\n\nАктивная машина: <b>${await getActiveMachineName()}</b>\n\nНажмите кнопку ниже чтобы переключиться на эту машину.`;
    const kb = [
      [{ text: `🔄 Переключить на ${CONFIG.machineName}`, callback_data: `switch_${CONFIG.machineName}` }],
      [{ text: '⬅️ Меню', callback_data: 'menu' }],
    ];
    const editId = messageId || state.lastMenuMessageId;
    if (editId) {
      const success = await editTelegramMessage(chatId, editId, text, kb);
      if (success) return;
    }
    const newId = await sendTelegramMessage(chatId, text, kb);
    if (newId) { state.lastMenuMessageId = newId; saveSession(); }
    return;
  }

  if (state.isRunning && state.browser && isPageValid()) {
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
    ? '🤖 <b>AutoClick</b>\n\nСкрипт запущен и ждёт команды.\nНажмите <b>▶️ Запустить учёт</b> чтобы начать учёт времени.\n\n' + BOT_COMMANDS
    : null;
  if (welcome) {
    if (messageId) {
      const success = await editTelegramMessage(chatId, messageId, welcome, getKeyboard());
      if (success) {
        state.lastMenuMessageId = messageId;
        saveSession();
        return;
      }
    }
    
    if (state.lastMenuMessageId) {
      await deleteTelegramMessage(chatId, state.lastMenuMessageId).catch(() => {});
      state.lastMenuMessageId = null;
    }
    const newId = await sendTelegramMessage(chatId, welcome, getKeyboard());
    if (newId) { state.lastMenuMessageId = newId; saveSession(); }
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

  // Release gist lock so another machine can take over
  if (CONFIG.gistId) {
    await releaseActive();
  }

  await sendMainMenu(chatId, '⏹ Учёт остановлен', messageId);
}

async function handleStatus(chatId, messageId) {
  await sendMainMenu(chatId, null, messageId);
}

async function handleHelp(chatId, messageId) {
  const helpText = [
    '📖 <b>Справка по командам</b>',
    '',
    '<b>Основные:</b>',
    '  /start — Показать главное меню',
    '  /stop — Остановить учёт времени',
    '  /status — Текущий статус',
    '  /restart — Перезапустить бота',
    '',
    '<b>Информация:</b>',
    '  /stats — Статистика с сайта',
    '  /machines — Список машин',
    '  /help — Эта справка',
    '',
    '<b>Системные:</b>',
    '  /update — Обновить код из репозитория',
    '',
    '<b>Управление кнопками:</b>',
    '  ▶️ Запустить учёт — Начать отсчёт времени',
    '  ⏹ Остановить учёт — Остановить',
    '  📊 Обновить статус — Обновить информацию',
    '  🖥️ Машины — Список и переключение машин',
  ].join('\n');

  const kb = [[{ text: '⬅️ Меню', callback_data: 'menu' }]];
  const editId = messageId || state.lastMenuMessageId;

  if (editId) {
    const success = await editTelegramMessage(chatId, editId, helpText, kb);
    if (success) return;
  }
  const newId = await sendTelegramMessage(chatId, helpText, kb);
  if (newId) { state.lastMenuMessageId = newId; saveSession(); }
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
  const editId = messageId || state.lastMenuMessageId;

  // Gist-based machine list (multi-machine mode)
  if (CONFIG.gistId) {
    const lock = await readGist();
    if (!lock) {
      const text = '❌ Не удалось прочитать реестр машин';
      const kb = [[{ text: '⬅️ Меню', callback_data: 'menu' }]];
      if (editId) await editTelegramMessage(chatId, editId, text, kb);
      else { const n = await sendTelegramMessage(chatId, text, kb); if (n) { state.lastMenuMessageId = n; saveSession(); } }
      return;
    }

    let text = '🖥️ <b>Машины AutoClick</b>\n\n';
    const machines = lock.machines || {};
    const names = Object.keys(machines).sort();

    for (const name of names) {
      const m = machines[name];
      const isActive = lock.active === name;
      const lastSeen = new Date(m.lastSeen);
      const ago = Math.floor((Date.now() - lastSeen.getTime()) / 1000);
      const isOnline = ago < 120;

      const icon = isActive ? '✅' : isOnline ? '⏸' : '❌';
      const statusText = isActive ? 'АКТИВНА' : isOnline ? 'Ожидание' : 'Офлайн';
      const agoText = ago < 60 ? `${ago}с` : `${Math.floor(ago / 60)}м`;
      const isCurrent = name === CONFIG.machineName;

      text += `${icon} <b>${name}</b> — ${statusText} (${agoText} назад)${isCurrent ? ' ← этот бот' : ''}\n`;
    }

    if (names.length === 0) {
      text += 'Нет зарегистрированных машин.';
    }

    text += `\n\nТекущая активная: <b>${lock.active || 'нет'}</b>`;

    const keyboard = [];
    for (const name of names) {
      if (name !== lock.active) {
        keyboard.push([{ text: `🔄 Включить ${name}`, callback_data: `switch_${name}` }]);
      }
    }
    keyboard.push([
      { text: '🔄 Обновить', callback_data: 'instances' },
      { text: '⬅️ Меню', callback_data: 'menu' },
    ]);

    let success = false;
    if (editId) success = await editTelegramMessage(chatId, editId, text, keyboard);
    if (!success) {
      const n = await sendTelegramMessage(chatId, text, keyboard);
      if (n) { state.lastMenuMessageId = n; saveSession(); }
    }
    return;
  }

  // Fallback: local PID-based instance list (single-machine mode)
  const { execSync } = require('child_process');
  let pids = [];
  try {
    const out = execSync(
      "ps axo pid,comm | grep '[n]ode' | awk '{print $1}'",
      { encoding: 'utf8' }
    ).trim();
    const nodePids = out ? out.split('\n').map(Number).filter(Boolean) : [];
    pids = nodePids.filter((pid) => {
      try {
        const args = execSync('ps -p ' + pid + ' -o args=', { encoding: 'utf8', timeout: 2000 }).trim();
        return args.includes('auto-click.js') && !args.includes('pgrep');
      } catch { return false; }
    });
  } catch {}

  const others = pids.filter(p => p !== process.pid);

  let text = `🖥️ <b>Экземпляры AutoClick</b>\n\n`;
  text += `▸ Текущий: PID <code>${process.pid}</code> (этот бот)\n`;

  if (others.length === 0) {
    text += '\n✅ Других экземпляров нет.';
    const kb = [[{ text: '⬅️ Меню', callback_data: 'menu' }]];
    let success = false;
    if (editId) success = await editTelegramMessage(chatId, editId, text, kb);
    if (!success) {
      const n = await sendTelegramMessage(chatId, text, kb);
      if (n) { state.lastMenuMessageId = n; saveSession(); }
    }
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

  let success = false;
  if (editId) success = await editTelegramMessage(chatId, editId, text, keyboard);
  if (!success) {
    const n = await sendTelegramMessage(chatId, text, keyboard);
    if (n) { state.lastMenuMessageId = n; saveSession(); }
  }
}

async function handleSwitchMachine(chatId, messageId, targetName) {
  if (!CONFIG.gistId) {
    await sendMainMenu(chatId, '❌ Переключение машин недоступно (нет GIST_ID)', messageId);
    return;
  }

  const editId = messageId || state.lastMenuMessageId;
  const text = `🔄 Переключение на <b>${targetName}</b>...`;
  if (editId) await editTelegramMessage(chatId, editId, text, [[{ text: '⏳...', callback_data: 'noop' }]]);

  const lock = await readGist();
  if (!lock) {
    await sendMainMenu(chatId, '❌ Ошибка чтения реестра', messageId);
    return;
  }

  lock.active = targetName;
  lock.telegramOffset = state.telegramOffset;
  if (!lock.machines) lock.machines = {};
  lock.machines[targetName] = lock.machines[targetName] || {};
  lock.machines[targetName].lastSeen = new Date().toISOString();
  lock.machines[targetName].status = 'standby';
  await writeGist(lock);

  await stopAutoClick();
  stopTelegramPolling();
  state.machineRole = 'standby';

  await sendTelegramMessage(state.telegramChatId,
    `✅ Переключено на <b>${targetName}</b>\n\n` +
    `Эта машина (${CONFIG.machineName}) переведена в режим ожидания.\n` +
    `Машина ${targetName} запустится через ~30 сек.`
  );

  startGistWatcher();
}

async function handleRestart(chatId, messageId) {
  if (state.startingUp) {
    await sendMainMenu(chatId, '⏳ Уже перезапускается...', messageId);
    return;
  }
  state.startingUp = true;
  await sendMainMenu(chatId, '🔄 Перезапускаю...', messageId);
  const restartTargetId = messageId || state.lastMenuMessageId;
  (async () => {
    await stopAutoClick();
    state.startTime = Date.now();
    state.clickCount = 0;
    state.nextClickTime = null;
    await startAutoClick();
    const msg = state.isRunning ? '🔄 Учёт перезапущен' : '❌ Ошибка при перезапуске';
    await sendMainMenu(chatId, msg, restartTargetId);
  })().catch((err) => {
    log('handleRestart bg error:', err.message);
    sendMainMenu(chatId, '❌ Ошибка: ' + err.message, restartTargetId).catch(() => {});
  }).finally(() => { state.startingUp = false; });
}

async function handleUpdateCode(chatId, msgId) {
  let statusMsgId = null;
  const steps = [
    'Получение свежего кода из репозитория (git pull)',
    'Установка npm-пакетов (npm install)',
    'Скачивание Chrome для Puppeteer'
  ];

  const renderText = (currentStepIndex, statusText) => {
    let t = '<b>🔄 Обновление AutoClick</b>\n\n';
    for (let i = 0; i < steps.length; i++) {
      if (i < currentStepIndex) {
        t += `✅ ${steps[i]}\n`;
      } else if (i === currentStepIndex) {
        t += `⏳ <b>${steps[i]}</b>...\n`;
      } else {
        t += `⚪️ ${steps[i]}\n`;
      }
    }
    if (statusText) {
      t += `\n${statusText}`;
    }
    return t;
  };

  try {
    const initialText = renderText(0);
    if (msgId) {
      const ok = await editTelegramMessage(chatId, msgId, initialText);
      statusMsgId = ok ? msgId : await sendTelegramMessage(chatId, initialText);
    } else {
      statusMsgId = await sendTelegramMessage(chatId, initialText);
    }

    const execCmd = (cmd) => {
      return new Promise((resolve, reject) => {
        const { exec } = require('child_process');
        exec(cmd, { cwd: __dirname }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr.trim() || stdout.trim() || error.message));
          } else {
            resolve(stdout);
          }
        });
      });
    };

    // DNS-проверка для github.com перед git pull
    try {
      await execCmd('host github.com 2>/dev/null || nslookup github.com 2>/dev/null');
    } catch {
      log('DNS: github.com не резолвится');
      log('DNS: попробуйте вручную: echo "140.82.121.3 github.com" | sudo tee -a /etc/hosts');
      // Продолжаем — может сработать через прокси или VPN
    }

    // Шаг 1: git pull
    const hasGit = fs.existsSync(path.join(__dirname, '.git'));
    if (hasGit) {
      // Проверяем есть ли коммиты в репозитории
      let hasCommits = false;
      try {
        await execCmd('git log -1');
        hasCommits = true;
      } catch {}

      if (!hasCommits) {
        // .git есть но нет коммитов — инициализируем заново
        log('Git repo пустой,重新 инициализация...');
        try {
          await execCmd('git remote remove origin 2>/dev/null || true');
          await execCmd('git remote add origin https://github.com/djek9007/auto-click.git');
          await execCmd('git fetch origin main');
          await execCmd('git reset --hard origin/main');
          log('Git repo восстановлен из remote');
        } catch (initErr) {
          throw new Error(
            'GitHub недоступен. Обновите вручную:\n' +
            '1. Скачайте auto-click.js с GitHub\n' +
            '2. Замените в ' + __dirname + '\n' +
            '3. bash start.sh'
          );
        }
      } else {
        // Есть коммиты — простой git pull
        try {
          await execCmd('git pull');
        } catch (pullErr) {
          throw new Error(
            'git pull не удался: ' + pullErr.message + '\n\n' +
            'Обновите вручную или проверьте сеть.'
          );
        }
      }
    } else {
      throw new Error(
        'Git не найден. Обновите вручную:\n' +
        '1. Скачайте auto-click.js с GitHub\n' +
        '2. Замените в ' + __dirname + '\n' +
        '3. bash start.sh'
      );
    }

    // Шаг 2
    await editTelegramMessage(chatId, statusMsgId, renderText(1));
    await execCmd('npm install --no-fund --no-audit');

    // Шаг 3
    await editTelegramMessage(chatId, statusMsgId, renderText(2));
    await execCmd('npx puppeteer browsers install chrome');

    // Готово!
    const successText = renderText(steps.length, '✅ <b>Обновление успешно завершено!</b>\n\nПерезапускаю бота для применения изменений...');
    await editTelegramMessage(chatId, statusMsgId, successText);

    log('Обновление завершено. Перезапуск через 2 секунды...');
    setTimeout(() => {
      const { spawn } = require('child_process');
      const startScript = path.join(__dirname, 'start.sh');
      const child = spawn('bash', [startScript], {
        detached: true,
        stdio: 'inherit',
        env: process.env,
      });
      child.unref();
      process.exit(0);
    }, 2000);

  } catch (err) {
    log('Ошибка обновления кода:', err.message);
    const errorText = `❌ <b>Ошибка обновления кода!</b>\n\n<code>${err.message.slice(0, 1000)}</code>\n\nПопробуйте запустить команду вручную.`;
    if (statusMsgId) {
      await editTelegramMessage(chatId, statusMsgId, errorText);
    } else {
      await sendTelegramMessage(chatId, errorText);
    }
  }
}

async function handleStats(chatId, messageId) {
  let text = '📈 <b>Статистика с сайта</b>\n\n';

  const reply = async (t, k) => {
    const editId = messageId || state.lastMenuMessageId;
    let success = false;
    if (editId) {
      success = await editTelegramMessage(chatId, editId, t, k);
    }
    if (!success) {
      const newId = await sendTelegramMessage(chatId, t, k);
      if (newId) { state.lastMenuMessageId = newId; saveSession(); }
    }
  };

  if (!isPageValid()) {
    // Страница отсоединена — сбросить состояние и сообщить пользователю
    state.page = null;
    text += '❌ Браузер не запущен.\nСначала нажмите <b>▶️ Запустить учёт</b>';
    await reply(text, getKeyboard());
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
      await reply(text, getKeyboard());
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
      await reply(text, getKeyboard());
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
    if (err.message.includes('detached') || err.message.includes('closed')) {
      state.page = null;
      text += '❌ Страница была закрыта. Нажмите <b>🔄 Перезапустить</b>.';
    } else {
      text += '❌ Ошибка: ' + err.message;
    }
  }

  await reply(text, getKeyboard());
}

// ─── Telegram API ──────────────────────────────────────────────────────────────
function getTelegramApi() { return `https://api.telegram.org/bot${CONFIG.telegramToken}`; }

// Вспомогательный хелпер для fetch с таймаутом, чтобы предотвратить зависание бота
async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 15000 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// Установка меню команд в Telegram (кнопка слева от ввода)
async function setupBotCommands() {
  if (!CONFIG.telegramToken) return;
  try {
    const commands = [
      { command: 'start',   description: 'Показать меню' },
      { command: 'stop',    description: 'Остановить учёт' },
      { command: 'status',  description: 'Текущий статус' },
      { command: 'stats',   description: 'Статистика с сайта' },
      { command: 'machines', description: 'Список машин' },
      { command: 'restart', description: 'Перезапустить' },
      { command: 'update',  description: 'Обновить код' },
      { command: 'help',    description: 'Справка по командам' },
    ];
    await fetchWithTimeout(`${getTelegramApi()}/setMyCommands`, {
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
    const resp = await fetchWithTimeout(`${getTelegramApi()}/sendMessage`, {
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
  if (!CONFIG.telegramToken || !chatId || !messageId) return false;
  try {
    const body = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
    if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
    const resp = await fetchWithTimeout(`${getTelegramApi()}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const r = await resp.json();
    if (!r.ok) {
      if (r.description && !r.description.includes('not modified')) {
        log('Telegram edit warning:', r.description);
      }
      return !!(r.description && r.description.includes('not modified'));
    }
    return true;
  } catch (err) {
    log('Telegram edit error:', err.message);
    return false;
  }
}

async function deleteTelegramMessage(chatId, messageId) {
  if (!CONFIG.telegramToken || !chatId || !messageId) return false;
  try {
    const resp = await fetchWithTimeout(`${getTelegramApi()}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    const r = await resp.json();
    return r.ok;
  } catch (err) {
    log('Telegram delete error:', err.message);
    return false;
  }
}

async function answerCallbackQuery(callbackId, text) {
  if (!CONFIG.telegramToken || !callbackId) return;
  try {
    await fetchWithTimeout(`${getTelegramApi()}/answerCallbackQuery`, {
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

    const resp = await fetchWithTimeout(`${getTelegramApi()}/getUpdates?${params}`, { timeout: 35000 });
    const data = await resp.json();

    if (!data.ok) {
      if (data.description && data.description.includes('conflict')) {
        log('⚠️ Ошибка Telegram: обнаружен конфликт (409). Похоже, запущен другой экземпляр бота с тем же токеном!');
      } else {
        log('Ошибка Telegram API:', data.description || 'Неизвестная ошибка');
      }
      return;
    }

    // Даже при пустом ответе сохраняем текущий offset — чтобы при перезапуске
    // не переигрывать старые команды
    saveOffset(state.telegramOffset);

    for (const update of data.result || []) {
      state.telegramOffset = update.update_id + 1;
      saveOffset(state.telegramOffset);

      // Игнорируем обновления старше 60 секунд (защита от дублей при перезапуске)
      // Только для обычных текстовых сообщений, так как у callback_query.message.date — это дата создания меню, которое может быть старым
      const updateDate = update.message?.date;
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
          case 'start':     handleStart(chatId, msgId).catch(err => log('Callback start error:', err.message)); break;
          case 'stop':      handleStop(chatId, msgId).catch(err => log('Callback stop error:', err.message)); break;
          case 'status':    handleStatus(chatId, msgId).catch(err => log('Callback status error:', err.message)); break;
          case 'stats':     handleStats(chatId, msgId).catch(err => log('Callback stats error:', err.message)); break;
          case 'restart':   handleRestart(chatId, msgId).catch(err => log('Callback restart error:', err.message)); break;
          case 'menu':      handleShowMenu(chatId, msgId).catch(err => log('Callback menu error:', err.message)); break;
          case 'instances': handleInstances(chatId, msgId).catch(err => log('Callback instances error:', err.message)); break;
          case 'kill_all_others': handleKillOthers(chatId, msgId).catch(err => log('Callback kill_all_others error:', err.message)); break;
          case 'update_code': handleUpdateCode(chatId, msgId).catch(err => log('Callback update_code error:', err.message)); break;
          case 'help':        handleHelp(chatId, msgId).catch(err => log('Callback help error:', err.message)); break;
          default:
            if (cbData.startsWith('switch_')) {
              const targetName = cbData.slice(7);
              handleSwitchMachine(chatId, msgId, targetName).catch(err => log('Callback switch error:', err.message));
            } else if (cbData.startsWith('kill_')) {
              const pid = parseInt(cbData.slice(5));
              handleKillPid(chatId, msgId, pid).catch(err => log('Callback kill_pid error:', err.message));
            } else {
              answerCallbackQuery(callbackId, 'Неизвестная команда').catch(() => {});
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
        handleShowMenu(msg.chat.id).catch(err => log('Text start error:', err.message));
      } else if (text === '/stop' || text === 'stop' || text === '⏹ остановить') {
        handleStop(msg.chat.id).catch(err => log('Text stop error:', err.message));
      } else if (text === '/status' || text === 'status' || text === '📊 статус') {
        handleStatus(msg.chat.id).catch(err => log('Text status error:', err.message));
      } else if (text === '/stats' || text === 'stats' || text === '📈 статистика' || text === '/statistic') {
        handleStats(msg.chat.id).catch(err => log('Text stats error:', err.message));
      } else if (text === '/restart' || text === 'restart' || text === '🔄 перезапустить') {
        handleRestart(msg.chat.id).catch(err => log('Text restart error:', err.message));
      } else if (text === '/update' || text === 'update' || text === 'обновить' || text === '/update_code') {
        handleUpdateCode(msg.chat.id).catch(err => log('Text update error:', err.message));
      } else if (text === '/menu' || text === 'menu' || text === '⚙️ меню') {
        handleShowMenu(msg.chat.id).catch(err => log('Text menu error:', err.message));
      } else if (text === '/help' || text === 'help' || text === 'помощь' || text === 'справка') {
        handleHelp(msg.chat.id).catch(err => log('Text help error:', err.message));
      } else if (text === '/machines' || text === 'машины' || text === 'machines') {
        handleInstances(msg.chat.id).catch(err => log('Text machines error:', err.message));
      } else {
        // Любое другое сообщение — просто показываем меню в чистоте (без дубликатов)
        handleShowMenu(msg.chat.id).catch(err => log('Text default error:', err.message));
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
      'Нажмите <b>▶️ Запустить учёт</b> чтобы начать учёт времени.\n' +
      'Настройки: ' + CONFIG.maxHours + ' часов, интервал ' + CONFIG.minIntervalMin + '-' + CONFIG.maxIntervalMin + ' мин.';
    let success = false;
    if (state.lastMenuMessageId) {
      success = await editTelegramMessage(state.telegramChatId, state.lastMenuMessageId, msg, getKeyboard());
    }
    if (!success) {
      const newId = await sendTelegramMessage(state.telegramChatId, msg, getKeyboard());
      if (newId) { state.lastMenuMessageId = newId; saveSession(); }
    }
  }

  const poll = async () => {
    let delay = 100;
    try {
      await pollTelegram();
    } catch (err) {
      log('Ошибка опроса Telegram, повтор через 3 сек:', err.message);
      delay = 3000;
    }
    if (!state.shutdownRequested) {
      telegramPollTimer = setTimeout(poll, delay);
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

    // Keep only last 20 screenshots
    const files = fs.readdirSync(SCREENSHOT_DIR)
      .filter(f => f.endsWith('.png'))
      .sort()
      .reverse();
    while (files.length >= 20) {
      try { fs.unlinkSync(path.join(SCREENSHOT_DIR, files.pop())); } catch {}
    }

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
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (err) {
    throw new Error(
      'Модуль puppeteer не установлен!\n\n' +
      'Выполните:\n' +
      '  npm install\n\n' +
      'Или:\n' +
      '  npm install puppeteer'
    );
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: CONFIG.headless ? 'new' : false,
      slowMo: CONFIG.slowMo,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
        '--window-size=1280,800',
        '--disable-blink-features=AutomationControlled',
      ],
    });
  } catch (launchErr) {
    const errMsg = launchErr.message || '';
    const isMissing = errMsg.includes('Could not find Chrome');
    const isFailed = errMsg.includes('Failed to launch');

    if (isMissing || isFailed) {
      log('Chrome проблема:', isMissing ? 'не найден' : 'не запускается', '- установка/переустановка...');

      // Удаляем старый кеш и ставим заново
      const { execSync } = require('child_process');
      try {
        execSync('npx puppeteer browsers install chrome --force', {
          cwd: __dirname,
          timeout: 180000,
          stdio: 'inherit',
        });
      } catch (installErr) {
        throw new Error(
          'Chrome не установлен.\n' +
          'Выполните вручную:\n' +
          '  cd ' + __dirname + '\n' +
          '  npx puppeteer browsers install chrome'
        );
      }

      // Пробуем снова с дополнительными флагами для macOS
      browser = await puppeteer.launch({
        headless: CONFIG.headless ? 'new' : false,
        slowMo: CONFIG.slowMo,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          '--single-process',
          '--window-size=1280,800',
          '--disable-blink-features=AutomationControlled',
        ],
      });
    } else {
      throw launchErr;
    }
  }

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
  // Remove any previous listeners to prevent accumulation on restart
  page.removeAllListeners('dialog');
  page.removeAllListeners('console');
  page.removeAllListeners('pageerror');
  page.removeAllListeners('requestfailed');
  page.removeAllListeners('response');
  page.removeAllListeners('popup');

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

  // Логирование JavaScript-ошибок на странице — для диагностики
  page.on('pageerror', (err) => {
    log('[Page JS Error]', err.message);
  });

  // Логирование упавших запросов ресурсов
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (!url.includes('google-analytics') && !url.includes('gtag') && !url.includes('favicon')) {
      log('[Request Failed]', url.slice(0, 150), request.failure()?.errorText);
    }
  });

  // Сброс перехваченных данных при каждой новой навигации
  state._loginResponse = null;
  state._popup = null;

  // Перехват ответов от auth endpoint
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('/login') || url.includes('/auth') || url.includes('/oauth') || url.includes('/casdoor')) {
      state._loginResponse = { url, status: resp.status() };
      log('Auth API ответ:', url, resp.status());
      try {
        const text = await resp.text();
        state._loginResponse.body = text.slice(0, 1000);
        log('Auth ответ (первые 200):', text.replace(/\s+/g, ' ').trim().slice(0, 200));
      } catch {}
    }
  });

  // Обработка всплывающих окон OAuth
  page.on('popup', async (popup) => {
    log('Всплывающее окно:', popup.url());
    state._popup = popup;
    try {
      await popup.waitForNavigation({ waitUntil: 'load', timeout: 15000 });
    } catch {}
  });
}

// ─── Authentication ────────────────────────────────────────────────────────────
async function login(page) {
  log('Проверка авторизации...');

  // Переход на страницу с обработкой ошибок навигации
  for (let navAttempt = 1; navAttempt <= 3; navAttempt++) {
    try {
      await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle0', timeout: 30000 });
      break;
    } catch (err) {
      if (err.message.includes('context was destroyed') || err.message.includes('navigation')) {
        log('Навигация прервана (попытка ' + navAttempt + '), повтор...');
        await sleep(3000);
        if (navAttempt === 3) throw err;
      } else {
        throw err;
      }
    }
  }

  await sleep(5000);

  // Check if already logged in
  try {
    const isLoggedIn = await checkLoggedIn(page);
    if (isLoggedIn) {
      log('Уже авторизован');
      return true;
    }
  } catch (err) {
    if (err.message.includes('context was destroyed')) {
      log('Контекст потерян после навигации, повторная загрузка...');
      await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle0', timeout: 30000 });
      await sleep(5000);
      const isLoggedIn = await checkLoggedIn(page);
      if (isLoggedIn) {
        log('Уже авторизован (после повтора)');
        return true;
      }
    } else {
      throw err;
    }
  }

  log('Авторизация не найдена. Запуск входа...');

  // Шаг 1: Ищем все кнопки/ссылки для входа на странице
  const authButtons = await page.evaluate(() => {
    const results = [];
    const els = document.querySelectorAll('button, a');
    const keywords = ['gitea', 'войти', 'login', 'sign in', 'войти через', 'signin',
                       '01-platform', '01 platform', 'вход', 'authorize', 'oauth',
                       'войти с помощью', 'continue with', 'casdoor'];
    for (const el of els) {
      const text = (el.textContent || '').trim().toLowerCase();
      const href = (el.getAttribute('href') || '').toLowerCase();
      const cls = (el.className || '').toLowerCase();
      for (const kw of keywords) {
        if (text.includes(kw) || href.includes(kw) || cls.includes(kw)) {
          results.push({ text: text.slice(0, 50), href: href.slice(0, 100), tag: el.tagName });
          break;
        }
      }
    }
    return results;
  }).catch(() => []);

  log('Найдено кнопок входа:', authButtons.length);
  for (const btn of authButtons) {
    log('  —', btn.tag, 'text:', btn.text, 'href:', btn.href);
  }

  // Шаг 2: Пробуем кликнуть по каждой кнопке входа
  let authStarted = false;
  const urlBefore = page.url();

  for (let attempt = 1; attempt <= 3; attempt++) {
    // Сбрасываем перехваченные данные
    state._loginResponse = null;
    state._popup = null;

    const clicked = await clickButtonByText(page, [
      'gitea', 'войти', 'login', 'sign in', 'войти через',
      '01-platform', '01 platform', 'вход', 'authorize',
      'continue with', 'signin'
    ]);

    if (!clicked) {
      log('Кнопка входа не найдена (попытка ' + attempt + ')');
      if (attempt === 3) {
        await takeScreenshot(page, 'no_login_button');
        throw new Error('Не найдено кнопки входа. Страница: ' + page.url());
      }
      await sleep(2000);
      continue;
    }

    log('Клик по кнопке входа (попытка ' + attempt + ')');

    // Ждём: либо навигацию, либо XHR ответ, либо всплывающее окно
    await sleep(3000);

    // Проверяем навигацию
    const urlAfter = page.url();
    if (urlAfter !== urlBefore && !urlAfter.includes('chrome-error')) {
      log('Навигация на:', urlAfter.slice(0, 100));
      authStarted = true;
      break;
    }

    // Проверяем всплывающее окно
    if (state._popup) {
      log('Обработка OAuth через всплывающее окно');
      const popup = state._popup;
      state._popup = null;
      try {
        await popup.bringToFront();
        await sleep(2000);
        // Пробуем заполнить форму в popup
        const filled = await fillLoginForm(popup);
        if (filled) {
          log('Форма заполнена в popup');
          await sleep(5000);
          // Закрываем popup и возвращаемся на основную страницу
          await popup.close().catch(() => {});
          await page.bringToFront();
          authStarted = true;
          break;
        }
      } catch (err) {
        log('Ошибка popup:', err.message);
      }
    }

    // Проверяем XHR ответ — если там есть redirect URL
    if (state._loginResponse && state._loginResponse.body) {
      const body = state._loginResponse.body;
      // Ищем URL для редиректа в JSON ответе
      const redirectMatch = body.match(/"?(?:redirect|redirect_uri|url|location|authUrl|authorization_url)"?\s*[:=]\s*"([^"]+)"/i);
      if (redirectMatch) {
        const redirectUrl = redirectMatch[1];
        log('Найден URL редиректа из XHR:', redirectUrl.slice(0, 100));
        await page.goto(redirectUrl, { waitUntil: 'networkidle0', timeout: 20000 }).catch(() => {});
        await sleep(3000);
        authStarted = true;
        break;
      }
    }

    log('Клик не дал результата, повтор...');
  }

  // Шаг 3: Если мы на странице логина — заполняем форму
  if (!authStarted) {
    await takeScreenshot(page, 'no_auth_redirect');
    log('Пробуем найти форму логина на текущей странице...');
  } else {
    // Перезагружаем страницу логина через goto — это гарантирует полную загрузку
    // с правильным waitUntil (в отличие от waitForNavigation, который мог пропустить событие)
    const loginUrl = page.url();
    log('Переход на страницу логина:', loginUrl.slice(0, 100));
    try {
      await page.goto(loginUrl, { waitUntil: 'networkidle0', timeout: 30000 });
      log('Страница логина загружена:', page.url().slice(0, 80));
    } catch (err) {
      log('Предупреждение: страница логина загружена с ошибкой:', err.message);
      await sleep(3000);
    }
  }

  const loggedIn = await fillLoginForm(page);
  if (!loggedIn) {
    await takeScreenshot(page, 'login_failed');
    throw new Error('Не удалось авторизоваться. Страница: ' + page.url());
  }

  // Шаг 4: Ждём редирект обратно на dashboard
  log('Ожидание редиректа на dashboard...');
  for (let i = 0; i < 12; i++) {
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 });
    } catch {}
    await sleep(3000);
    const loggedIn = await checkLoggedIn(page);
    if (loggedIn) {
      log('Авторизация успешна');
      await notifyTelegram('🔓 Успешный вход в систему');
      return true;
    }
  }

  // Шаг 5: Финальная проверка — ждём загрузки дашборда
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
    if (hasMenu) {
      log('Дашборд загружен');
      // Запускаем учёт времени
      await ensureTrackingActive(page);
      return true;
    }
    log('Ожидание дашборда...');
    await sleep(3000);
  }

  throw new Error('Не удалось загрузить дашборд после входа. Страница: ' + page.url());
}

// ─── Fill Login Form ──────────────────────────────────────────────────────────
async function fillLoginForm(page) {
  // Проверяем, может мы уже авторизованы
  if (await checkLoggedIn(page)) {
    log('Уже авторизован (fillLoginForm)');
    return true;
  }

  log('Поиск формы логина...');

  // Пробуем дождаться формы через waitForSelector (надёжнее чем ручной цикл)
  let inputs = [];
  const FORM_SELECTORS = [
    '#login_signin_form input:not([type="hidden"])',
    'form .field input:not([type="hidden"])',
    'form input[type="text"], form input[type="email"], form input[type="password"]',
    'input[name="user_name"], input[name="login"], input[name="email"]',
    '#login_name, #user_name, #email-field, input[autocomplete="email"]',
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"])',
    'input',
  ];

  const getInputs = async () => {
    for (const selector of FORM_SELECTORS) {
      try {
        const found = await page.$$(selector);
        if (found.length >= 2) {
          return { inputs: found, selector };
        }
      } catch {}
    }
    return { inputs: [], selector: null };
  };

  let searchResult = await getInputs();
  inputs = searchResult.inputs;

  // Если поля не найдены, возможно это страница выбора способа входа (OAuth2)
  if (inputs.length < 2) {
    log('Поля ввода формы не найдены. Проверяем наличие кнопок внешнего входа (OAuth2/OIDC)...');
    
    // Ищем ссылки внешнего входа
    const extLoginSelector = 'a.external-login-link, a[href*="/oauth2/"], a[href*="/oauth/"], a[href*="/casdoor"], button.external-login-link';
    const extLoginLink = await page.$(extLoginSelector).catch(() => null);
    
    if (extLoginLink) {
      const extInfo = await page.evaluate(el => ({
        text: el.textContent.trim(),
        href: el.getAttribute('href')
      }), extLoginLink).catch(() => ({}));
      
      log(`Найден внешний вход (OAuth2): "${extInfo.text || ''}" [${extInfo.href || ''}]. Переходим...`);
      
      // Кликаем по ссылке внешнего входа
      await extLoginLink.click();
      
      // Ждем навигации и загрузки новой страницы
      log('Ожидаем перенаправления на страницу авторизации SSO...');
      await sleep(6000);
      
      // Проверяем поля на новой странице
      searchResult = await getInputs();
      inputs = searchResult.inputs;
      if (inputs.length >= 2) {
        log('Поля найдены на странице SSO по селектору: ' + searchResult.selector);
      }
    }
  }

  // Если всё ещё ничего не нашли — полная диагностика
  if (inputs.length < 2) {
    inputs = await page.$$('input').catch(() => []);
    log('Найдено input элементов:', inputs.length, 'на', page.url());

    if (inputs.length === 0) {
      const diag = await page.evaluate(() => {
        const f = document.querySelector('form');
        return {
          forms: document.forms.length,
          hasForm: !!f,
          formAction: f ? f.action : null,
          formHtml: f ? f.innerHTML.slice(0, 500) : null,
          bodyHtml: document.body ? document.body.innerHTML.slice(0, 1500) : null,
          iframes: document.querySelectorAll('iframe').length,
          shadowRoots: [...document.querySelectorAll('*')].filter(el => el.shadowRoot).length,
          url: window.location.href,
        };
      }).catch(() => ({}));
      log('Диагностика формы:', JSON.stringify(diag, null, 2).slice(0, 1000));
      log('Поля ввода не найдены');
      return false;
    }
  }

  // Логируем найденные поля для диагностики
  const foundInputs = await page.evaluate(() => {
    return [...document.querySelectorAll('input')].map(i => ({
      name: i.getAttribute('name'),
      id: i.getAttribute('id'),
      type: i.getAttribute('type'),
      placeholder: i.getAttribute('placeholder'),
      autocomplete: i.getAttribute('autocomplete'),
    }));
  }).catch(() => []);
  if (foundInputs.length > 0) {
    log('Поля на странице:', JSON.stringify(foundInputs));
  }

  // Пробуем найти поля email/password — разные варианты для разных систем
  let emailInput = await page.$(
    '#email-field, input[name="email"], input[type="email"], input[autocomplete="email"], ' +
    'input[name="user_name"], input[name="login"], input[name="username"], ' +
    '#input_email, #login_name, #user_name'
  );
  let passwordInput = await page.$(
    '#password-field, input[name="password"], input[type="password"], input[autocomplete="current-password"], ' +
    'input[name="passwd"], input[name="password"]'
  );

  if (!emailInput || !passwordInput) {
    // Fallback: первый и второй input
    if (inputs.length < 2) {
      inputs = await page.$$('input').catch(() => []);
    }
    if (inputs.length >= 2) {
      emailInput = inputs[0];
      passwordInput = inputs[1];
    } else {
      log('Поля ввода не найдены');
      return false;
    }
  }

  // Заполняем форму
  log('Заполнение формы логина...');
  try {
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(CONFIG.email, { delay: 50 });
    log('Email введён');

    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(CONFIG.password, { delay: 30 });
    log('Пароль введён');
  } catch (err) {
    log('Ошибка ввода:', err.message);
    return false;
  }

  // Отправка формы
  let submitBtn = await page.$(
    'button[type="submit"], #login-form button, .login-card__cta button, ' +
    '.form-actions button, .sign-in-button'
  ).catch(() => null);

  if (submitBtn) {
    await submitBtn.click();
    log('Клик по кнопке входа');
  } else {
    // Пробуем кликнуть по тексту кнопки
    const clickedByText = await page.evaluate(() => {
      const btns = document.querySelectorAll('button, input[type="submit"], a.button');
      const keywords = ['login', 'sign in', 'войти', 'log in'];
      for (const btn of btns) {
        const text = (btn.textContent || btn.value || '').toLowerCase();
        for (const kw of keywords) {
          if (text.includes(kw)) {
            btn.click();
            return true;
          }
        }
      }
      return false;
    }).catch(() => false);

    if (clickedByText) {
      log('Клик по кнопке входа по тексту');
    } else {
      await page.keyboard.press('Enter');
      log('Отправка через Enter');
    }
  }

  await sleep(5000);

  // Verify login actually succeeded
  const loggedIn = await checkLoggedIn(page);
  if (loggedIn) {
    log('Вход подтверждён');
    return true;
  }

  // Check if there's an error message on page
  const errorMsg = await page.evaluate(() => {
    const errEl = document.querySelector('.error, .alert, .message-error, [class*="error"]');
    return errEl ? errEl.textContent.trim() : null;
  }).catch(() => null);

  if (errorMsg) {
    log('Ошибка входа:', errorMsg);
  } else {
    log('Вход не подтверждён (нет ошибки на странице)');
  }
  return false;
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
        if ((text.includes('запустить учёт') || text.includes('начать учёт') ||
             text.includes('запуск учёта') || text.includes('start tracking') ||
             text === 'start учёт') &&
            !text.includes('проект')) {
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

    // 2. Find and click a random menu button in one evaluate call
    const clickResult = await page.evaluate((texts) => {
      const allBtns = document.querySelectorAll('button');
      const matching = [];
      for (const btn of allBtns) {
        const trimmed = btn.textContent.trim();
        for (const text of texts) {
          if (trimmed.includes(text)) {
            matching.push({ btn, text: trimmed });
            break;
          }
        }
      }
      if (matching.length === 0) return { clicked: false };
      const target = matching[Math.floor(Math.random() * matching.length)];
      target.btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.btn.click();
      return { clicked: true, text: target.text };
    }, MENU_TEXTS);

    if (!clickResult.clicked) {
      log('Кнопки меню не найдены, скролл вверх');
      const scrollUp = getRandomInt(100, 200);
      await page.evaluate((amount) => {
        window.scrollBy({ top: -amount, behavior: 'smooth' });
      }, scrollUp);
      await sleep(1000);
      return { success: true, action: 'scrolled_only' };
    }

    log('Клик на:', clickResult.text);
    state.clickCount++;
    log('Активность выполнена. Всего кликов:', state.clickCount);
    return { success: true, action: 'clicked', buttonText: clickResult.text };
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
        state.nextClickTime = null;
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
    const activityResult = await performActivity(page);
    if (!activityResult.success) {
      log('Активность не выполнена:', activityResult.error || 'unknown');
    }

    // Calculate next interval (5-12 min)
    const intervalMin = getRandomInt(CONFIG.minIntervalMin, CONFIG.maxIntervalMin);
    const intervalMs = intervalMin * 60 * 1000;
    const nextTime = new Date(Date.now() + intervalMs);
    state.nextClickTime = nextTime;
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
    if (state.browser && isPageValid()) {
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

    const page = isPageValid() ? state.page : await state.browser.newPage();
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
  state.nextClickTime = null;
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
  const newId = await sendTelegramMessage(state.telegramChatId, text, getKeyboard());
  if (newId) { state.lastMenuMessageId = newId; saveSession(); }
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────
async function shutdown() {
  if (state.shutdownRequested) return;
  state.shutdownRequested = true;

  log('Завершение работы...');
  stopTelegramPolling();

  if (state.gistCheckTimer) clearInterval(state.gistCheckTimer);

  // Release gist lock on shutdown
  if (CONFIG.gistId && state.machineRole === 'active') {
    try {
      const lock = await readGist();
      if (lock) {
        if (lock.active === CONFIG.machineName) lock.active = null;
        if (lock.machines && lock.machines[CONFIG.machineName]) {
          lock.machines[CONFIG.machineName].status = 'offline';
          lock.machines[CONFIG.machineName].lastSeen = new Date().toISOString();
        }
        await writeGist(lock);
        log('Gist lock released');
      }
    } catch (err) { log('Shutdown gist error:', err.message); }
  }

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
  log('AutoClick v2.1.0 — Запуск...');
  log('Node.js:', process.version);

  // Load remote config from Gist if CONFIG_GIST_ID is set
  await loadRemoteConfig();

  // Validate config
  if (!CONFIG.email || !CONFIG.password || !CONFIG.telegramToken) {
    console.error('Ошибка: EMAIL, PASSWORD и TELEGRAM_TOKEN обязательны');
    console.error('  Укажите в .env или создайте Gist с config.json и задайте CONFIG_GIST_ID');
    console.error('  См. .env.example');
    process.exit(1);
  }

  // Set up signal handlers
  process.on('SIGINT', () => { shutdown().catch(() => process.exit(1)); });
  process.on('SIGTERM', () => { shutdown().catch(() => process.exit(1)); });
  process.on('uncaughtException', (err) => {
    log('Непредвиденная ошибка:', err.message);
    shutdown().catch(() => {});
    setTimeout(() => process.exit(1), 5000);
  });

  process.on('unhandledRejection', (reason) => {
    log('Unhandled rejection:', reason instanceof Error ? reason.message : String(reason));
  });

  // Настраиваем меню команд в Telegram (кнопка слева от ввода)
  await setupBotCommands();

  log(`Машина: ${CONFIG.machineName}`);

  // Multi-machine coordination via GitHub Gist
  if (CONFIG.gistId && CONFIG.githubToken) {
    log('Multi-machine режим: Gist координация активна');
    await registerMachine();
    const lock = await readGist();
    if (lock && lock.active === CONFIG.machineName) {
      // This machine is already active
      state.machineRole = 'active';
      state.telegramOffset = lock.telegramOffset || 0;
      saveOffset(state.telegramOffset);
      log('Эта машина — активная');
    } else if (!lock || !lock.active) {
      // No machine active — become active automatically
      // Random delay to avoid race condition when multiple machines start simultaneously
      await sleep(getRandomInt(1000, 5000));
      // Re-check after delay
      const lock2 = await readGist();
      if (lock2 && lock2.active && lock2.active !== CONFIG.machineName) {
        state.machineRole = 'standby';
        log(`Другая машина стала активной: ${lock2.active}`);
        startGistWatcher();
        // Запускаем Telegram polling даже в standby
        startTelegramPolling();
        await sendStartupMenu();
        await new Promise(() => {});
        return;
      }
      state.machineRole = 'active';
      await claimActive();
      log('Нет активной машины — эта машина стала активной');
    } else {
      // Another machine is active — standby
      state.machineRole = 'standby';
      log(`Ожидание. Активная машина: ${lock.active}`);
      startGistWatcher();
      // Запускаем Telegram polling даже в standby — чтобы можно было переключать машины
      startTelegramPolling();
      await sendStartupMenu();
      await new Promise(() => {});
      return;
    }
  } else {
    state.machineRole = 'active';
    log('Multi-machine отключён (нет GIST_ID)');
  }

  // Active machine: start Telegram polling
  if (process.env.AUTO_START === 'true') {
    log('AUTO_START: запуск автоклика без команды Telegram...');
    startTelegramPolling();
    await sendStartupMenu();
    await startAutoClick();
  } else {
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
