// PM2 config for Playwright worker on VPS
// Runs browser-based scrapers (MEXC, KuCoin, BingX, etc.)

module.exports = {
  apps: [
    {
      name: 'playwright-worker',
      script: 'npx',
      args: 'tsx src/index.ts --category cex-browser --daemon',
      cwd: '/root/arena-worker',
      env: {
        NODE_ENV: 'production',
        // Use snap chromium on Ubuntu VPS
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/snap/bin/chromium',
        // Reduce memory usage
        PLAYWRIGHT_BROWSERS_PATH: '/root/.cache/ms-playwright',
      },
      max_memory_restart: '800M',
      restart_delay: 10000,
      max_restarts: 20,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/root/arena-worker/logs/playwright-error.log',
      out_file: '/root/arena-worker/logs/playwright-out.log',
      merge_logs: true,
    },
    {
      name: 'api-worker',
      script: 'npx',
      args: 'tsx src/index.ts --category cex-api --daemon',
      cwd: '/root/arena-worker',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '500M',
      restart_delay: 5000,
      max_restarts: 10,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/root/arena-worker/logs/api-error.log',
      out_file: '/root/arena-worker/logs/api-out.log',
      merge_logs: true,
    },
  ],
}
