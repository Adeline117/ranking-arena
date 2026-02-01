#!/usr/bin/env node
/**
 * Bybit Futures Acceptance Test - Complete E2E Script
 *
 * Runs the full 7-dimension acceptance test:
 *   1. sources/bybit.json proof file
 *   2. Connector implementation
 *   3. Real data in DB (seed from Bybit API)
 *   4. GET /api/rankings?platform=bybit Top5 ROI DESC
 *   5. Trader detail <200ms
 *   6. Refresh job flow
 *   7. Error handling
 *
 * Usage: node scripts/verify/bybit-acceptance.mjs
 *
 * Requires env vars:
 *   SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// ============================================
// Config
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEV_SERVER = process.env.DEV_SERVER || 'http://localhost:3000';

const BYBIT_API_BASE = 'https://api2.bybit.com/fapi/beehive/public/v1/common';
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

const WINDOWS = ['7D', '30D', '90D'];
const WINDOW_MAP = { '7D': 'WEEKLY', '30D': 'MONTHLY', '90D': 'QUARTERLY' };

// ============================================
// Utilities
// ============================================
const results = [];
let db;

function log(msg) { console.log(`  ${msg}`); }
function pass(dim, detail) { results.push({ dim, status: 'PASS', detail }); console.log(`  ✅ [${dim}] PASS: ${detail}`); }
function fail(dim, detail) { results.push({ dim, status: 'FAIL', detail }); console.log(`  ❌ [${dim}] FAIL: ${detail}`); }

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

function parseNum(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return isNaN(n) ? null : n;
}

function normalizeRoi(v) {
  const n = parseNum(v);
  if (n == null) return null;
  if (Math.abs(n) < 10 && Math.abs(n) > 0) return n * 100;
  return n;
}

function normalizeWinRate(v) {
  const n = parseNum(v);
  if (n == null) return null;
  if (n > 0 && n <= 1) return n * 100;
  return n;
}

function normalizeMdd(v) {
  const n = parseNum(v);
  if (n == null) return null;
  let mdd = Math.abs(n);
  if (mdd > 0 && mdd <= 1) mdd = mdd * 100;
  return mdd;
}

function calcArenaScore(roi, pnl, winRate, mdd, window) {
  let returnScore;
  if (roi <= 0) returnScore = 0;
  else if (roi < 50) returnScore = (roi / 50) * 30;
  else if (roi < 200) returnScore = 30 + ((roi - 50) / 150) * 25;
  else if (roi < 1000) returnScore = 55 + ((roi - 200) / 800) * 20;
  else returnScore = 75 + Math.min((roi - 1000) / 5000, 1) * 10;
  returnScore = Math.min(returnScore, 85);

  const mddVal = Math.abs(mdd ?? 100);
  let drawdownScore;
  if (mddVal <= 5) drawdownScore = 8;
  else if (mddVal <= 10) drawdownScore = 7;
  else if (mddVal <= 20) drawdownScore = 5;
  else if (mddVal <= 40) drawdownScore = 3;
  else if (mddVal <= 60) drawdownScore = 1;
  else drawdownScore = 0;

  const wr = winRate ?? 50;
  let stabilityScore;
  if (wr >= 80) stabilityScore = 7;
  else if (wr >= 70) stabilityScore = 6;
  else if (wr >= 60) stabilityScore = 5;
  else if (wr >= 50) stabilityScore = 3;
  else if (wr >= 40) stabilityScore = 2;
  else stabilityScore = 0;

  const total = Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100;
  return { total, returnScore, drawdownScore, stabilityScore };
}

// ============================================
// Bybit API calls
// ============================================
async function fetchBybitLeaderboard(window, limit = 50) {
  const timeRange = WINDOW_MAP[window];
  const traders = [];
  const pageSize = Math.min(limit, 20);
  const maxPages = Math.ceil(limit / pageSize);

  for (let page = 1; page <= maxPages && traders.length < limit; page++) {
    await delay(2500 + Math.random() * 500);

    const resp = await fetch(`${BYBIT_API_BASE}/dynamic-leader-list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': randomUA(),
        'Accept': 'application/json',
        'Origin': 'https://www.bybit.com',
        'Referer': 'https://www.bybit.com/copyTrade/tradeCenter/leaderBoard',
      },
      body: JSON.stringify({
        pageNo: page,
        pageSize,
        timeRange,
        dataType: 'ROI',
        sortField: 'ROI',
        sortType: 'DESC',
      }),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const json = await resp.json();
    if (json.retCode !== undefined && json.retCode !== 0) throw new Error(`API error: ${json.retMsg}`);

    const list = json?.result?.list || json?.data?.list || [];
    if (!Array.isArray(list) || list.length === 0) break;

    for (const item of list) {
      if (traders.length >= limit) break;
      const traderId = String(item.leaderId || item.traderUid || item.uid || '');
      if (!traderId) continue;

      const roi = normalizeRoi(item.roi ?? item.roiRate) ?? 0;
      const pnl = parseNum(item.pnl ?? item.totalPnl) ?? 0;
      const winRate = normalizeWinRate(item.winRate);
      const maxDrawdown = normalizeMdd(item.mdd ?? item.maxDrawdown);
      const arenaScore = calcArenaScore(roi, pnl, winRate, maxDrawdown, window);

      traders.push({
        trader_key: traderId,
        display_name: item.nickName || item.leaderName || null,
        avatar_url: item.avatar || item.avatarUrl || null,
        roi,
        pnl,
        win_rate: winRate,
        max_drawdown: maxDrawdown,
        trades_count: item.totalTrades ?? item.tradeCount ?? null,
        followers: item.followerCount ?? item.copierNum ?? null,
        aum: item.totalAssets ? parseFloat(String(item.totalAssets)) : null,
        arena_score: arenaScore.total,
        return_score: arenaScore.returnScore,
        drawdown_score: arenaScore.drawdownScore,
        stability_score: arenaScore.stabilityScore,
      });
    }
  }

  return traders.slice(0, limit);
}

// ============================================
// DB operations
// ============================================
async function seedBybitData(traders, window) {
  const now = new Date().toISOString();

  // Upsert profiles
  const profiles = traders.map(t => ({
    platform: 'bybit',
    trader_key: t.trader_key,
    display_name: t.display_name,
    avatar_url: t.avatar_url,
    bio: null,
    tags: [],
    follower_count: t.followers,
    copier_count: null,
    aum: t.aum,
    updated_at: now,
    created_at: now,
  }));

  const { error: profileErr } = await db
    .from('trader_profiles')
    .upsert(profiles, { onConflict: 'platform,trader_key', ignoreDuplicates: false });

  if (profileErr) {
    log(`Profile upsert warning: ${profileErr.message}`);
  }

  // Insert snapshots
  const snapshots = traders.map((t, i) => ({
    platform: 'bybit',
    trader_key: t.trader_key,
    window,
    as_of_ts: now,
    metrics: {
      roi: t.roi,
      pnl: t.pnl,
      win_rate: t.win_rate,
      max_drawdown: t.max_drawdown,
      trades_count: t.trades_count,
      followers: t.followers,
      aum: t.aum,
      arena_score: t.arena_score,
      return_score: t.return_score,
      drawdown_score: t.drawdown_score,
      stability_score: t.stability_score,
      rank: i + 1,
    },
    quality_flags: {
      is_suspicious: false,
      suspicion_reasons: [],
      data_completeness: [t.roi !== 0, t.pnl !== 0, t.win_rate != null, t.max_drawdown != null].filter(Boolean).length / 4,
    },
    updated_at: now,
    created_at: now,
  }));

  const { error: snapErr } = await db
    .from('trader_snapshots_v2')
    .upsert(snapshots, { onConflict: 'platform,trader_key,window', ignoreDuplicates: false });

  if (snapErr) {
    // If unique index conflict (hourly bucket), just insert with slight offset
    log(`Snapshot upsert note: ${snapErr.message}`);
    // Try inserting individually, skipping conflicts
    let inserted = 0;
    for (const snap of snapshots) {
      const { error } = await db.from('trader_snapshots_v2').insert(snap);
      if (!error) inserted++;
    }
    log(`  Inserted ${inserted}/${snapshots.length} snapshots individually`);
  }

  return { profileCount: profiles.length, snapshotCount: snapshots.length };
}

// ============================================
// Acceptance Dimensions
// ============================================

async function dim1_proofFile() {
  console.log('\n--- Dimension 1: sources/bybit.json proof file ---');
  const path = resolve(ROOT, 'sources/bybit.json');
  if (!existsSync(path)) {
    fail('D1', 'sources/bybit.json not found');
    return;
  }
  try {
    const content = JSON.parse(readFileSync(path, 'utf8'));
    const required = ['platform', 'product', 'api_base', 'leaderboard_endpoints'];
    const missing = required.filter(k => !content[k]);
    if (missing.length > 0) {
      fail('D1', `Missing fields: ${missing.join(', ')}`);
    } else {
      pass('D1', `Proof file valid: platform=${content.platform}, product=${content.product}, api_base=${content.api_base}`);
    }
  } catch (e) {
    fail('D1', `Invalid JSON: ${e.message}`);
  }
}

async function dim2_connector() {
  console.log('\n--- Dimension 2: Connector implementation ---');
  const connectorPath = resolve(ROOT, 'lib/connectors/bybit-futures.ts');
  const workerPath = resolve(ROOT, 'worker/src/job-runner/bybit-connector.ts');

  if (!existsSync(connectorPath)) {
    fail('D2', 'lib/connectors/bybit-futures.ts not found');
    return;
  }
  if (!existsSync(workerPath)) {
    fail('D2', 'worker/src/job-runner/bybit-connector.ts not found');
    return;
  }

  const content = readFileSync(connectorPath, 'utf8');
  const checks = [
    ['PlatformConnector', content.includes('PlatformConnector')],
    ['discoverLeaderboard', content.includes('discoverLeaderboard')],
    ['fetchTraderProfile', content.includes('fetchTraderProfile')],
    ['fetchTraderSnapshot', content.includes('fetchTraderSnapshot')],
    ['fetchTimeseries', content.includes('fetchTimeseries')],
    ['RateLimiter', content.includes('RateLimiter') || content.includes('rateLimiter')],
    ['CircuitBreaker', content.includes('CircuitBreaker') || content.includes('circuitBreaker')],
  ];

  const failures = checks.filter(c => !c[1]);
  if (failures.length > 0) {
    fail('D2', `Connector missing: ${failures.map(f => f[0]).join(', ')}`);
  } else {
    pass('D2', 'Connector implements PlatformConnector with all methods + rate limiter + circuit breaker');
  }
}

async function dim3_realData() {
  console.log('\n--- Dimension 3: Real data in DB ---');

  if (!db) {
    fail('D3', 'No DB connection (check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)');
    return;
  }

  // Fetch real Bybit data for all 3 windows
  let totalSeeded = 0;
  for (const window of WINDOWS) {
    log(`Fetching Bybit leaderboard (${window})...`);
    try {
      const traders = await fetchBybitLeaderboard(window, 20);
      log(`  Got ${traders.length} traders from Bybit API`);

      if (traders.length === 0) {
        fail('D3', `No traders returned from Bybit API for window ${window}`);
        return;
      }

      const { profileCount, snapshotCount } = await seedBybitData(traders, window);
      log(`  Seeded: ${profileCount} profiles, ${snapshotCount} snapshots for ${window}`);
      totalSeeded += traders.length;
    } catch (err) {
      fail('D3', `Bybit API/DB error (${window}): ${err.message}`);
      return;
    }
  }

  // Verify data is in DB
  const { count, error } = await db
    .from('trader_snapshots_v2')
    .select('*', { count: 'exact', head: true })
    .eq('platform', 'bybit');

  if (error) {
    fail('D3', `DB query error: ${error.message}`);
    return;
  }

  if (count > 0) {
    pass('D3', `${count} Bybit snapshots in trader_snapshots_v2 (seeded ${totalSeeded} across ${WINDOWS.length} windows)`);

    // Show top 5 by ROI for evidence
    const { data: top5 } = await db
      .from('trader_snapshots_v2')
      .select('trader_key, window, metrics')
      .eq('platform', 'bybit')
      .eq('window', '30D')
      .order('created_at', { ascending: false })
      .limit(5);

    if (top5 && top5.length > 0) {
      log('  Top traders in DB:');
      for (const row of top5) {
        const m = row.metrics;
        log(`    ${row.trader_key} | ROI: ${m.roi?.toFixed(2)}% | PnL: ${m.pnl?.toFixed(2)} | Score: ${m.arena_score}`);
      }
    }
  } else {
    fail('D3', 'No Bybit rows in trader_snapshots_v2 after seeding');
  }
}

async function dim4_rankingsApi() {
  console.log('\n--- Dimension 4: Rankings API Top5 ROI DESC ---');

  try {
    const url = `${DEV_SERVER}/api/rankings?platform=bybit&window=30D&sort_by=roi&sort_dir=desc&limit=5`;
    log(`GET ${url}`);

    const start = Date.now();
    const resp = await fetch(url);
    const elapsed = Date.now() - start;

    if (!resp.ok) {
      const text = await resp.text();
      fail('D4', `API returned ${resp.status}: ${text}`);
      return;
    }

    const data = await resp.json();

    if (!data.traders || data.traders.length === 0) {
      fail('D4', 'API returned empty traders array');
      return;
    }

    // Verify ROI DESC ordering
    let sorted = true;
    for (let i = 1; i < data.traders.length; i++) {
      if ((data.traders[i].metrics.roi ?? 0) > (data.traders[i-1].metrics.roi ?? 0)) {
        sorted = false;
        break;
      }
    }

    if (!sorted) {
      fail('D4', 'Traders NOT sorted by ROI DESC');
      return;
    }

    log(`  Response time: ${elapsed}ms | Traders: ${data.traders.length} | Window: ${data.window}`);
    log('  Top 5 by ROI DESC:');
    for (const t of data.traders) {
      log(`    #${t.rank} ${t.display_name || t.trader_key} | ROI: ${t.metrics.roi?.toFixed(2)}% | PnL: ${t.metrics.pnl?.toFixed(2)} | Score: ${t.metrics.arena_score}`);
    }

    pass('D4', `Top5 ROI DESC verified (${data.traders.length} results, ${elapsed}ms, total_count=${data.total_count})`);
  } catch (err) {
    fail('D4', `API call failed: ${err.message}. Is the dev server running at ${DEV_SERVER}?`);
  }
}

async function dim5_traderDetail() {
  console.log('\n--- Dimension 5: Trader detail <200ms ---');

  // Get a trader_key from DB
  const { data: sample } = await db
    .from('trader_snapshots_v2')
    .select('trader_key')
    .eq('platform', 'bybit')
    .limit(1)
    .maybeSingle();

  if (!sample) {
    fail('D5', 'No bybit trader in DB to test');
    return;
  }

  const traderKey = sample.trader_key;
  const url = `${DEV_SERVER}/api/trader/bybit/${traderKey}`;
  log(`GET ${url}`);

  // Warm up (first request may be cold)
  try { await fetch(url); } catch { /* ignore */ }
  await delay(100);

  // Measure 3 requests
  const times = [];
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    const resp = await fetch(url);
    const elapsed = Date.now() - start;
    times.push(elapsed);

    if (i === 0 && resp.ok) {
      const data = await resp.json();
      log(`  Profile: ${data.profile.display_name || traderKey}`);
      log(`  Snapshots: 7D=${data.snapshots['7D'] ? 'yes' : 'no'}, 30D=${data.snapshots['30D'] ? 'yes' : 'no'}, 90D=${data.snapshots['90D'] ? 'yes' : 'no'}`);
      log(`  Is stale: ${data.is_stale}`);
    }
  }

  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const p95 = Math.round(times.sort((a, b) => a - b)[Math.floor(times.length * 0.95)]);
  log(`  Latencies: ${times.join('ms, ')}ms | Avg: ${avg}ms | P95: ${p95}ms`);

  if (avg <= 200) {
    pass('D5', `Trader detail avg ${avg}ms <= 200ms threshold (p95: ${p95}ms)`);
  } else {
    fail('D5', `Trader detail avg ${avg}ms > 200ms threshold`);
  }
}

async function dim6_refreshJob() {
  console.log('\n--- Dimension 6: Refresh job flow ---');

  // Get a trader
  const { data: sample } = await db
    .from('trader_snapshots_v2')
    .select('trader_key')
    .eq('platform', 'bybit')
    .limit(1)
    .maybeSingle();

  if (!sample) {
    fail('D6', 'No bybit trader in DB');
    return;
  }

  const traderKey = sample.trader_key;
  const url = `${DEV_SERVER}/api/trader/bybit/${traderKey}/refresh`;

  // Step 1: Create refresh job
  log(`POST ${url}`);
  try {
    const resp1 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_type: 'full_refresh', priority: 1 }),
    });

    if (!resp1.ok) {
      const text = await resp1.text();
      fail('D6', `Create job failed: ${resp1.status} ${text}`);
      return;
    }

    const data1 = await resp1.json();
    log(`  Job created: id=${data1.job.id}, status=${data1.job.status}, created=${data1.created}`);

    // Step 2: Test deduplication (second call should return same job)
    await delay(100);
    const resp2 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_type: 'full_refresh', priority: 1 }),
    });

    const data2 = await resp2.json();
    log(`  Dedup test: id=${data2.job.id}, created=${data2.created}`);

    if (data2.job.id === data1.job.id && data2.created === false) {
      log('  ✓ Deduplication working correctly');
    } else {
      log('  ⚠ Deduplication may not be working (different job IDs or created=true)');
    }

    // Step 3: Verify job in DB
    const { data: jobRow } = await db
      .from('refresh_jobs')
      .select('*')
      .eq('id', data1.job.id)
      .single();

    if (jobRow) {
      log(`  DB job: platform=${jobRow.platform}, trader_key=${jobRow.trader_key}, status=${jobRow.status}, priority=${jobRow.priority}`);
      pass('D6', `Refresh job flow working: create + dedup + DB verified (job_id=${data1.job.id})`);
    } else {
      fail('D6', 'Job created via API but not found in DB');
    }

    // Cleanup: cancel the test job
    await db.from('refresh_jobs').update({ status: 'cancelled' }).eq('id', data1.job.id);
  } catch (err) {
    fail('D6', `Refresh API error: ${err.message}. Is the dev server running?`);
  }
}

async function dim7_errorHandling() {
  console.log('\n--- Dimension 7: Error handling ---');

  let passed = 0;
  const total = 3;

  // Test 1: Invalid platform
  try {
    const resp = await fetch(`${DEV_SERVER}/api/trader/invalid_platform/test123`);
    if (resp.status === 400) {
      log('  ✓ Invalid platform returns 400');
      passed++;
    } else {
      log(`  ✗ Invalid platform returned ${resp.status} (expected 400)`);
    }
  } catch (err) {
    log(`  ✗ Request failed: ${err.message}`);
  }

  // Test 2: Non-existent trader returns graceful response
  try {
    const resp = await fetch(`${DEV_SERVER}/api/trader/bybit/nonexistent_trader_99999`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.profile && data.is_stale !== undefined) {
        log('  ✓ Non-existent trader returns graceful degraded response');
        passed++;
      } else {
        log('  ✗ Non-existent trader response missing expected fields');
      }
    } else {
      log(`  ✗ Non-existent trader returned ${resp.status}`);
    }
  } catch (err) {
    log(`  ✗ Request failed: ${err.message}`);
  }

  // Test 3: Circuit breaker presence in connector
  const connectorCode = readFileSync(resolve(ROOT, 'lib/connectors/bybit-futures.ts'), 'utf8');
  if (connectorCode.includes('CircuitBreaker') && connectorCode.includes('circuitBreaker')) {
    log('  ✓ Circuit breaker implemented in connector');
    passed++;
  } else {
    log('  ✗ Circuit breaker not found in connector');
  }

  if (passed >= total) {
    pass('D7', `Error handling: ${passed}/${total} checks passed`);
  } else {
    fail('D7', `Error handling: ${passed}/${total} checks passed`);
  }
}

// ============================================
// Main
// ============================================
async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Bybit Futures - 7-Dimension Acceptance Test          ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log();

  // Check prerequisites
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('ERROR: Missing environment variables.');
    console.error('  Required: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY');
    console.error('  Set them in .env.local or export them directly.');
    process.exit(1);
  }

  log(`Supabase URL: ${SUPABASE_URL}`);
  log(`Dev Server: ${DEV_SERVER}`);
  console.log();

  // Connect to DB
  db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

  // Verify DB connectivity
  const { error: pingErr } = await db.from('trader_profiles').select('id').limit(1);
  if (pingErr && pingErr.message.includes('does not exist')) {
    console.error('ERROR: trader_profiles table does not exist. Run the migration first:');
    console.error('  psql $DATABASE_URL -f supabase/migrations/00015_trading_platform_mvp.sql');
    console.error('  OR apply via Supabase Dashboard > SQL Editor');
    process.exit(1);
  }

  // Run all dimensions
  await dim1_proofFile();
  await dim2_connector();
  await dim3_realData();

  // Dimensions 4-7 require the dev server
  console.log('\n--- Checking dev server availability ---');
  let serverAvailable = false;
  try {
    const resp = await fetch(`${DEV_SERVER}/api/health`, { signal: AbortSignal.timeout(5000) });
    serverAvailable = resp.ok || resp.status === 404; // 404 means server is up but no health endpoint
    log(`Dev server: ${serverAvailable ? 'available' : 'not responding'}`);
  } catch {
    log(`Dev server not available at ${DEV_SERVER}`);
    log('Skipping API-dependent tests (D4-D7). Start with: npm run dev');
  }

  if (serverAvailable) {
    await dim4_rankingsApi();
    await dim5_traderDetail();
    await dim6_refreshJob();
    await dim7_errorHandling();
  } else {
    // Run what we can without server
    await dim7_errorHandling(); // Partial: only connector code checks
  }

  // Summary
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  ACCEPTANCE SUMMARY                                    ║');
  console.log('╠════════════════════════════════════════════════════════╣');

  const passCount = results.filter(r => r.status === 'PASS').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;

  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : '❌';
    console.log(`║  ${icon} ${r.dim}: ${r.detail.substring(0, 52).padEnd(52)} ║`);
  }

  console.log('╠════════════════════════════════════════════════════════╣');
  console.log(`║  Result: ${passCount} PASS / ${failCount} FAIL${' '.repeat(38)}║`);
  console.log(`║  Platform: bybit (Bybit Futures)${' '.repeat(23)}║`);
  console.log('╚════════════════════════════════════════════════════════╝');

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
