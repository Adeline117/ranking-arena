/**
 * PM2 ecosystem for the Singapore VPS INGEST worker (region vps_sg).
 *
 * The main worker/ecosystem.config.cjs only declares the Mac Mini apps
 * (arena-worker + arena-ingest-worker). The SG box runs a differently-NAMED app
 * (arena-ingest-worker-sg) so the drift sentinel + deploy script can target it
 * distinctly — but that name was never in any ecosystem, so the deploy script's
 * `pm2 start … --only arena-ingest-worker-sg` fallback had nothing to start.
 * This file fixes that. It is rsynced to /opt/arena-ingest (under worker/).
 *
 * NOTE: the region pinning (INGEST_REGIONS=vps_sg, INGEST_LOCAL_REGION=vps_sg)
 * lives in the box-local worker/.env (NOT rsynced, NOT here) — keep it that way
 * so this file is identical everywhere and never leaks the Mac's regions to SG.
 */
module.exports = {
  apps: [
    {
      name: 'arena-ingest-worker-sg',
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
      // Same ceiling as the Mac ingest app — Tier-A crawls + Playwright need room.
      max_memory_restart: '3072M',
      node_args: '--max-old-space-size=2560',
      kill_timeout: 30000,
      listen_timeout: 10000,
    },
  ],
}
