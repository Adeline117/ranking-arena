/**
 * PM2 ecosystem config for Arena Pipeline Worker.
 *
 * Usage on Mac Mini:
 *   cd /path/to/ranking-arena
 *   pm2 start worker/ecosystem.config.cjs
 *   pm2 logs arena-worker
 *   pm2 monit
 */
module.exports = {
  apps: [
    {
      name: 'arena-worker',
      script: 'npx',
      args: 'tsx worker/src/index.ts',
      cwd: __dirname + '/..',
      env_file: 'worker/.env',
      // Auto-restart on crash
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      // Logs
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'worker/logs/error.log',
      out_file: 'worker/logs/out.log',
      merge_logs: true,
      // Memory guard — restart if worker leaks beyond 512MB
      max_memory_restart: '512M',
      // Graceful shutdown (SIGINT → worker.close())
      kill_timeout: 30000,
      listen_timeout: 10000,
    },
  ],
}
