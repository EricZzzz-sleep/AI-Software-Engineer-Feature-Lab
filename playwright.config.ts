import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3199', viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: 'NODE_ENV=test DATABASE_PATH=:memory: npx tsx tests/browser-server.ts',
    url: 'http://127.0.0.1:3199/health', reuseExistingServer: false,
  },
});
