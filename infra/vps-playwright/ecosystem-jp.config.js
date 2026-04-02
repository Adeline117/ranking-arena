// JP VPS: HTTP proxy only (lightweight)
// Handles geo-blocked API forwarding (Binance, CoinEx, etc.)
// NO scraper, NO cron — those run on SG VPS
//
// Deployed to: /opt/arena-cron/ecosystem-jp.config.js

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
        PROXY_KEY: 'arena-proxy-sg-2026',
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
