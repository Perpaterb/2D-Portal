import { defineConfig } from '@playwright/test';

const target = process.env.TARGET_URL;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: target ?? 'http://localhost:4173/2D-Portal/',
    viewport: { width: 1280, height: 800 },
  },
  webServer: target
    ? undefined
    : {
        command: 'npm run build && npm run preview',
        url: 'http://localhost:4173/2D-Portal/',
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
