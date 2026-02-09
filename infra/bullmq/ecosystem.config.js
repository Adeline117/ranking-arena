module.exports = {
  apps: [{
    name: 'arena-worker',
    script: 'worker.js',
    cwd: '/root/arena-bullmq',
    env: {
      NODE_ENV: 'production',
    },
    max_memory_restart: '500M',
    restart_delay: 5000,
    max_restarts: 10,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/root/arena-bullmq/logs/error.log',
    out_file: '/root/arena-bullmq/logs/out.log',
    merge_logs: true,
  }],
};
