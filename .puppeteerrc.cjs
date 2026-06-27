const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Направляем кэш Puppeteer (включая Chromium) в локальную папку проекта,
  // чтобы избежать проблем с правами и путями в разных окружениях (например, Guest на macOS).
  cacheDirectory: join(__dirname, 'node_modules', '.cache', 'puppeteer'),
};
