import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const systemChromium = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
export default defineConfig({
  testDir: './tests',
  testMatch: ['browser.spec.ts', 'ai-browser.spec.ts', 'installation.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: {timeout: 15000},
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    baseURL: process.env.BASE_URL || process.env.APP_URL || 'http://127.0.0.1:3000',
    headless: true,
    viewport: {width: 1440, height: 1080},
    screenshot: 'only-on-failure',
    trace: 'off',
    launchOptions: {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || systemChromium, args: ['--no-sandbox', '--disable-dev-shm-usage']},
  },
});
