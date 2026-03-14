import { defineConfig, devices } from '@playwright/test'

/**
 * Round 2测试专用配置 - 使用已运行的开发服务器
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'round2-interaction.spec.ts',
  
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  
  fullyParallel: false,
  retries: 0,
  workers: 1,
  
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/round2-results.json' }],
  ],
  
  use: {
    baseURL: 'http://localhost:3000',
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
    trace: 'on',
    screenshot: 'on',
    video: 'on',
  },
  
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  
  // 不启动webServer，使用已运行的服务器
});
