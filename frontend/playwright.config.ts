import { defineConfig, devices } from '@playwright/test'

// Own ports so e2e runs never touch the dev servers on 4000/5173
const API_PORT = 4100
const WEB_PORT = 5174

export default defineConfig({
  testDir: './e2e',
  // *.e2e.ts so Vitest's default *.test/*.spec pattern never picks these up
  testMatch: '**/*.e2e.ts',
  globalSetup: './e2e/global-setup.ts',
  reporter: [['list'], ['html', { open: 'never' }]],
  // Login does a real bcrypt check; first requests also wait on a cold backend
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'desktop-safari', use: { ...devices['Desktop Safari'] } },
    { name: 'tablet-ipad', use: { ...devices['iPad (gen 7)'] } },
    { name: 'mobile-android', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-iphone', use: { ...devices['iPhone 14'] } },
  ],
  webServer: [
    {
      // Backend against the dev database; a fresh process each run resets the in-memory rate limits
      command: 'npx tsx --env-file=.env src/server.ts',
      cwd: '../backend',
      url: `http://localhost:${API_PORT}/api/v1/health`,
      env: { PORT: String(API_PORT), LOGIN_RATE_LIMIT_MAX: '50' },
      reuseExistingServer: false,
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}/login`,
      env: { VITE_API_PROXY_TARGET: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
    },
  ],
})
