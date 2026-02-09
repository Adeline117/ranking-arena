#!/usr/bin/env node
// Arena BullMQ Worker — replaces Vercel Cron
// Runs all 38 cron jobs via BullMQ repeatable queues
// Includes circuit breaker, retry with exponential backoff, health tracking, and Telegram alerts

require('dotenv').config();
const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const { CircuitBreaker, FAILURE_THRESHOLD } = require('./circuit-breaker');
const { alertFetcherDown, alertStaleData, alertCPU, alertRecovery, getCPUUsage } = require('./alert');
const JOBS = require('./jobs');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://www.arenafi.org';
const CRON_SECRET = process.env.CRON_SECRET || '';

// Connection
const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const healthRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const cb = new CircuitBreaker(healthRedis);

const QUEUE_NAME = 'arena-cron';

// --- Cron schedule to interval ms (approximate, for stale detection) ---
function cronToIntervalMs(cron) {
  const parts = cron.split(' ');
  const min = parts[0], hour = parts[1];
  if (min.startsWith('*/')) return parseInt(min.slice(2)) * 60 * 1000;
  if (hour.startsWith('*/')) return parseInt(hour.slice(2)) * 3600 * 1000;
  if (hour.includes(',')) {
    const hours = hour.split(',');
    return (24 / hours.length) * 3600 * 1000;
  }
  // hourly default
  return 3600 * 1000;
}

// --- HTTP call with exponential backoff ---
async function callEndpoint(path, retries = 4) {
  const url = `${APP_BASE_URL}${path}`;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 16000);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000); // 2min timeout

      const headers = { 'Content-Type': 'application/json' };
      if (CRON_SECRET) {
        headers['Authorization'] = `Bearer ${CRON_SECRET}`;
        headers['x-cron-secret'] = CRON_SECRET;
      }

      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) return { ok: true, status: res.status };

      const body = await res.text().catch(() => '');
      lastError = `HTTP ${res.status}: ${body.slice(0, 200)}`;

      // Don't retry 4xx (except 429)
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        break;
      }
    } catch (err) {
      lastError = err.message || String(err);
    }
  }

  throw new Error(lastError);
}

// --- Setup queue and register repeatable jobs ---
async function setupQueue() {
  const queue = new Queue(QUEUE_NAME, { connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }) });

  // Remove old repeatable jobs first to avoid duplicates
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }
  console.log(`Cleared ${existing.length} old repeatable jobs`);

  // Add all jobs
  for (const job of JOBS) {
    await queue.add(job.name, { path: job.path, jobName: job.name }, {
      repeat: { pattern: job.cron },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    });
    console.log(`  ✓ ${job.name} [${job.cron}]`);
  }

  console.log(`\nRegistered ${JOBS.length} repeatable jobs`);
  return queue;
}

// --- Worker processor ---
async function startWorker() {
  const worker = new Worker(QUEUE_NAME, async (job) => {
    const { path, jobName } = job.data;
    const name = jobName || job.name;

    // Circuit breaker check
    const canRun = await cb.canExecute(name);
    if (!canRun) {
      console.log(`⛔ [${name}] Circuit OPEN — skipping`);
      return { skipped: true, reason: 'circuit_open' };
    }

    const start = Date.now();
    try {
      console.log(`▶ [${name}] ${path}`);
      const result = await callEndpoint(path);
      const latency = Date.now() - start;

      // Check if was previously broken → recovery alert
      const prevState = await cb.getState(name);
      if (prevState.consecutiveFailures >= FAILURE_THRESHOLD) {
        await alertRecovery(name);
      }

      await cb.recordSuccess(name, latency);
      console.log(`✅ [${name}] ${latency}ms`);
      return { ok: true, latency };
    } catch (err) {
      const latency = Date.now() - start;
      const failures = await cb.recordFailure(name, err.message);
      console.error(`❌ [${name}] ${latency}ms — ${err.message} (failures: ${failures})`);

      if (failures === FAILURE_THRESHOLD) {
        await alertFetcherDown(name, failures, err.message);
      }

      throw err; // Let BullMQ record it as failed
    }
  }, {
    connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }),
    concurrency: 5,
    limiter: { max: 10, duration: 1000 }, // max 10 jobs/sec
  });

  worker.on('error', err => console.error('Worker error:', err.message));
  worker.on('failed', (job, err) => {
    // Already logged in processor
  });

  return worker;
}

// --- Stale data monitor (every 10 min) ---
function startStaleMonitor() {
  setInterval(async () => {
    try {
      for (const job of JOBS) {
        const state = await cb.getState(job.name);
        if (!state.lastSuccess) continue;
        const intervalMs = cronToIntervalMs(job.cron);
        const staleness = Date.now() - new Date(state.lastSuccess).getTime();
        if (staleness > intervalMs * 3) {
          await alertStaleData(job.name, state.lastSuccess, intervalMs);
        }
      }
    } catch (err) {
      console.error('Stale monitor error:', err.message);
    }
  }, 10 * 60 * 1000); // every 10 min
}

// --- CPU monitor (every 5 min) ---
function startCPUMonitor() {
  setInterval(async () => {
    try {
      const cpu = getCPUUsage();
      if (cpu > 85) {
        await alertCPU(cpu);
      }
    } catch (err) {
      console.error('CPU monitor error:', err.message);
    }
  }, 5 * 60 * 1000);
}

// --- Main ---
async function main() {
  console.log('🏟️  Arena BullMQ Worker starting...');
  console.log(`   App: ${APP_BASE_URL}`);
  console.log(`   Redis: ${REDIS_URL}`);
  console.log(`   Telegram: ${process.env.TELEGRAM_BOT_TOKEN ? 'configured' : '⚠️  NOT configured'}`);
  console.log('');

  await setupQueue();
  await startWorker();
  startStaleMonitor();
  startCPUMonitor();

  console.log('\n🚀 Worker running. Press Ctrl+C to stop.\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => { console.log('\nShutting down...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\nShutting down...'); process.exit(0); });
