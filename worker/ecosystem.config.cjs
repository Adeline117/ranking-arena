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
    {
      // New unified ingestion orchestrator (ARENA_DATA_SPEC v1.2).
      // Separate app + queue from arena-worker: a crash loop in new code
      // must never stall the live pipeline during the parallel build.
      name: 'arena-ingest-worker',
      script: 'npx',
      args: 'tsx worker/src/ingest-worker.ts',
      cwd: __dirname + '/..',
      env_file: 'worker/.env',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'worker/logs/ingest-error.log',
      out_file: 'worker/logs/ingest-out.log',
      merge_logs: true,
      // 1024M was killing the process mid-crawl every ~32 min (28 restarts
      // in 15h), so 25-90min Tier-A crawls NEVER finished a full cycle —
      // the root cause of the STALE-source backlog. 3 concurrent Playwright
      // sessions + remote connect comfortably exceed 1GB. 16GB host → 3GB
      // ceiling gives every crawl room to complete; Node heap raised to match.
      max_memory_restart: '3072M',
      node_args: '--max-old-space-size=2560',
      kill_timeout: 30000,
      listen_timeout: 10000,
    },
  ],
}
