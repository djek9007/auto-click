# Repository Guidelines

## Project Structure & Module Organization

`auto-click.js` is the application entry point. It contains dashboard automation, Telegram control, configuration loading, and runtime-state handling. Keep related changes together in this file unless a module has a clear independent responsibility.

Shell scripts provide platform integration: `start.sh` launches and prepares the app, `install.sh` installs a macOS LaunchDaemon or Linux systemd service, and `uninstall.sh` removes it. `Запустить AutoClick.command` is the macOS double-click launcher. User documentation lives in `README.md` and `GUEST_MODE.md`.

Runtime files such as `.tg_offset`, `.tg_session`, `.auto-click.pid`, logs, screenshots, `node_modules/`, and `.env` files are ignored and must not be committed.

## Build, Test, and Development Commands

- `npm ci` installs the exact dependency versions from `package-lock.json`.
- `npm start` or `node auto-click.js` runs the automation locally.
- `HEADLESS=false SLOW_MO=50 npm start` opens the browser for interactive debugging.
- `bash -n start.sh install.sh uninstall.sh` checks shell-script syntax without executing installation steps.
- `node --check auto-click.js` checks JavaScript syntax without launching Puppeteer.

There is no compilation step or automated test suite. Do not run `sudo bash install.sh` for routine development; it writes system service files and starts the application.

## Coding Style & Naming Conventions

Use strict CommonJS JavaScript compatible with Node.js 18+. Follow the existing style: two-space indentation, semicolons, single quotes, `camelCase` for functions and variables, and `UPPER_SNAKE_CASE` for constants and environment keys. Keep shell scripts POSIX-aware where practical, retain `#!/bin/bash`, quote variable expansions, and fail early with `set -e`.

No formatter or linter is configured. Match nearby code and keep diffs focused.

## Testing Guidelines

For every change, run the syntax checks above. For automation changes, test once with `HEADLESS=false`, verify login/navigation behavior, and confirm Telegram commands affected by the change. Never use production credentials in fixtures or logs. If adding tests, place them in `test/` and name files `*.test.js`; add the corresponding `npm test` script.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style subjects with an emoji, for example `🐛 fix: улучшить запуск браузера`. Keep subjects imperative, concise, and scoped to one change.

Pull requests should explain the behavior change, list manual checks, identify affected platforms, and link relevant issues. Include screenshots or sanitized log excerpts when browser or Telegram behavior changes. Never commit `.env`, tokens, passwords, Gist IDs, session state, or generated logs.
