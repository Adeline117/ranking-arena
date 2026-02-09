#!/usr/bin/env node
// Health check CLI — view status of all jobs
require('dotenv').config();
const Redis = require('ioredis');
const { CircuitBreaker } = require('./circuit-breaker');

async function main() {
  const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
  const cb = new CircuitBreaker(redis);
  const states = await cb.getAllStates();

  const entries = Object.entries(states).sort((a, b) => a[0].localeCompare(b[0]));

  if (entries.length === 0) {
    console.log('No health data yet. Worker may not have run.');
    process.exit(0);
  }

  console.log(`\n${'Job'.padEnd(40)} ${'State'.padEnd(10)} ${'Fails'.padEnd(6)} ${'Latency'.padEnd(10)} Last Success`);
  console.log('─'.repeat(100));

  let openCount = 0;
  for (const [name, s] of entries) {
    const stateIcon = s.state === 'CLOSED' ? '🟢' : s.state === 'OPEN' ? '🔴' : '🟡';
    if (s.state === 'OPEN') openCount++;
    const latency = s.avgLatency ? `${Math.round(s.avgLatency)}ms` : '-';
    const lastOk = s.lastSuccess ? new Date(s.lastSuccess).toLocaleString() : 'never';
    console.log(`${stateIcon} ${name.padEnd(38)} ${s.state.padEnd(10)} ${String(s.consecutiveFailures).padEnd(6)} ${latency.padEnd(10)} ${lastOk}`);
  }

  console.log(`\nTotal: ${entries.length} jobs, ${openCount} circuits open\n`);
  redis.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
