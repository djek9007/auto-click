# AutoClick Project Memory

## Project Overview
- **AutoClick v2.0.0** — Node.js automation tool for educational dashboard (`dashboard.tomorrow-school.ai`)
- Single-file architecture: `auto-click.js` (1759 lines)
- Uses Puppeteer for browser automation, Telegram bot (`@OlzhtomBot`) for remote control
- Authenticates via Gitea + 01-platform OAuth2/SSO
- Simulates user activity (scroll + click menu buttons) every 5–12 minutes
- Controlled via Telegram: `/start`, `/stop`, `/status`, `/stats`, `/restart`, `/update`

## Architecture Decisions
- **Single-file design** — all logic in `auto-click.js`, no modules [ses_0e7adcde0ffegbOjiWnBqF0Hpz]
- **Telegram polling** — uses `getUpdates` with long polling (25s timeout), not webhooks
- **Session persistence** — `chatId` and `menuMessageId` saved to `.tg_session` to survive restarts
- **PID file** — `.auto-click.pid` prevents multiple instances, cleaned up on exit
- **Offset persistence** — `.tg_offset` saves Telegram offset to prevent replaying old commands
- **Startup menu** — bot sends fresh menu message on each restart via `sendStartupMenu()`

## Discovered Durable Knowledge
- **SPA navigation** — dashboard is React SPA; URL doesn't change on internal navigation. Always navigate to home page before extracting stats [ses_0e7da1db2ffew2J4wWzsxrVSCW]
- **Geolocation override** — uses CDP `Emulation.setGeolocationOverride` with school coordinates (51.089159, 71.415595)
- **OAuth2 flow** — handles Gitea + 01-platform SSO, may open popup windows for auth
- **Activity simulation** — random scroll (200–400px) + hover + click on random menu button (Leaderboard, Маркетплейс, Профиль, Главная)
- **innerText normalization** — must normalize `\n` to spaces before regex matching in stats extraction [ses_0e7da1db2ffew2J4wWzsxrVSCW]

## Patterns
- **Telegram message editing** — bot remembers `lastMenuMessageId` and edits same message instead of sending new ones to avoid chat spam
- **Background task capture** — `startTargetId = messageId || state.lastMenuMessageId` must be captured immediately before async operations to avoid updating wrong message
- **PID-based process management** — uses `ps axo pid,comm | grep '[n]ode'` + `ps -p PID -o args=` to find auto-click instances (avoids false positives from `pgrep -f` matching shell wrappers)
- **Graceful stop** — `stopAutoClick()` closes browser, `activityLoop` checks `state.isRunning` and `state.shutdownRequested` flags

## Gotchas
- **Telegram conflict (409)** — running multiple bot instances with same token causes conflict error; must stop other instances first [ses_0e7da1db2ffew2J4wWzsxrVSCW]
- **const → let fallback** — `emailInput`/`passwordInput` must be `let` because fallback branch reassigns them (was `const` → TypeError)
- **ESRCH = success** — `process.kill(pid)` throws ESRCH if process already dead; should be treated as success, not error
- **Offset replay** — if `.tg_offset` not saved, bot replays all old commands on restart; must save offset after every poll, even when empty
- **Multiple instances** — old `start.sh` didn't always kill stale processes; PID file + `kill -9` fallback needed
- **SPA URL checking unreliable** — can't rely on `page.url()` to detect current page in React SPA; always navigate to home before stats
- **Stats regex** — `\n` in `innerText` breaks regex patterns; normalize with `.replace(/\s+/g, ' ')` before matching
- **Telegram bot on multiple machines** — same token used on two machines causes duplicate responses; must stop bot on other machine

## Files
- `auto-click.js` — main application (1759 lines)
- `.tg_offset` — Telegram polling offset (persists across restarts)
- `.tg_session` — Telegram chatId and menuMessageId (persists across restarts)
- `.auto-click.pid` — PID file for process management
- `start.sh` — startup script with PID-based kill logic
- `install.sh` — system installation (macOS LaunchDaemon / Linux systemd)
- `package.json` — dependencies: puppeteer only
