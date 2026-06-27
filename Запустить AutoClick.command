#!/bin/bash
# Запуск AutoClick двойным кликом (Mac)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
node auto-click.js
