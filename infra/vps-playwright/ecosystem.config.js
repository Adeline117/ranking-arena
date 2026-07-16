// SG VPS: Playwright scraper + HTTP proxy
// The unified ingest worker is managed separately. Legacy arena-cron is retired.
// PM2 config for the two services owned by this deployment.
// Deployed to: /opt/arena-cron/ecosystem.config.js
//
// Services:
//   1. arena-scraper  — Playwright browser scraper (port 3457)
//   2. arena-proxy    — HTTP reverse proxy (port 3456)
// Secrets must be injected by the host environment. Never bake them into this file.

const proxyKeyCurrent = process.env.PROXY_KEY_CURRENT?.trim() || process.env.PROXY_KEY?.trim()
const proxyKeyNext = process.env.PROXY_KEY_NEXT?.trim()
if (!proxyKeyCurrent && !proxyKeyNext) {
  throw new Error('PROXY_KEY_CURRENT, PROXY_KEY_NEXT, or PROXY_KEY is required')
}
const proxyKeyEnv = {
  PROXY_KEY_CURRENT: proxyKeyCurrent || '',
  PROXY_KEY_NEXT: proxyKeyNext || '',
  PROXY_KEY: proxyKeyNext || proxyKeyCurrent,
}

module.exports = {
  apps: [
    // ── Playwright Scraper (port 3457) ──
    {
      name: 'arena-scraper',
      script: '/opt/scraper/server.js',
      cwd: '/opt/scraper',
      env: {
        NODE_ENV: 'production',
        PORT: '3457',
        ...proxyKeyEnv,
      },
      max_memory_restart: '500M',
      cron_restart: '0 */6 * * *', // auto-restart every 6h to prevent memory leak
      restart_delay: 10000,
      max_restarts: 20,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/opt/arena-cron/logs/scraper-error.log',
      out_file: '/opt/arena-cron/logs/scraper-out.log',
      merge_logs: true,
    },

    // ── HTTP Proxy (port 3456) ──
    {
      name: 'arena-proxy',
      script: '/opt/arena-proxy/server.mjs',
      cwd: '/opt/arena-proxy',
      env: {
        NODE_ENV: 'production',
        PORT: '3456',
        ...proxyKeyEnv,
      },
      max_memory_restart: '300M',
      cron_restart: '0 */12 * * *', // restart every 12h
      restart_delay: 5000,
      max_restarts: 10,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/opt/arena-cron/logs/proxy-error.log',
      out_file: '/opt/arena-cron/logs/proxy-out.log',
      merge_logs: true,
    },
  ],
}
