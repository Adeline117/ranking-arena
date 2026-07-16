// JP VPS: HTTP proxy only (lightweight)
// Handles geo-blocked API forwarding (Binance, CoinEx, etc.)
// NO scraper, NO cron — those run on SG VPS
//
// Deployed to: /opt/arena-cron/ecosystem-jp.config.js

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
  ],
}
