// SG VPS: Primary scraper + proxy + cron
// PM2 config for Arena VPS services
// Deployed to: /opt/arena-cron/ecosystem.config.js
//
// Services:
//   1. arena-scraper  — Playwright browser scraper (port 3457)
//   2. arena-proxy    — HTTP reverse proxy (port 3456)
//   3. arena-cron     — Periodic data fetch + Supabase write
//
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
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
        TELEGRAM_ALERT_CHAT_ID: process.env.TELEGRAM_ALERT_CHAT_ID || '',
      },
      max_memory_restart: '500M',
      cron_restart: '0 */6 * * *',   // auto-restart every 6h to prevent memory leak
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
      cron_restart: '0 */12 * * *',  // restart every 12h
      restart_delay: 5000,
      max_restarts: 10,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/opt/arena-cron/logs/proxy-error.log',
      out_file: '/opt/arena-cron/logs/proxy-out.log',
      merge_logs: true,
    },

    // ── Scraper Cron (runs every 3h via PM2 cron) ──
    {
      name: 'arena-cron',
      script: '/opt/arena-cron/scraper-cron.mjs',
      cwd: '/opt/arena-cron',
      cron_restart: '0 0,3,6,9,12,15,18,21 * * *',
      autorestart: false,            // cron-driven, don't restart on exit
      env: {
        NODE_ENV: 'production',
        ...proxyKeyEnv,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
        TELEGRAM_ALERT_CHAT_ID: process.env.TELEGRAM_ALERT_CHAT_ID || '',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/opt/arena-cron/logs/cron-error.log',
      out_file: '/opt/arena-cron/logs/cron-out.log',
      merge_logs: true,
    },
  ],
}
