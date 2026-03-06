#!/usr/bin/env node
/**
 * Consolidated data freshness check script.
 *
 * Usage:
 *   node scripts/check-freshness.mjs              # basic (default)
 *   node scripts/check-freshness.mjs --basic      # basic data freshness
 *   node scripts/check-freshness.mjs --platform   # platform-level freshness
 *   node scripts/check-freshness.mjs --detailed   # detailed freshness (recent 50 snapshots)
 *   node scripts/check-freshness.mjs --cron       # cron log check
 *   node scripts/check-freshness.mjs --all        # run all checks
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://iknktzifjdyujdccyhsv.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------------------------------------------------------------------------
// --basic: Basic data freshness (originally check_data_freshness.mjs)
// ---------------------------------------------------------------------------
async function checkBasic() {
  // 1. Check trader_snapshots per source
  console.log('=== Trader Snapshots by Source ===\n');

  const { data: sources, error: sourcesError } = await supabase
    .from('trader_snapshots')
    .select('source')
    .limit(10000);

  if (sourcesError) {
    console.log('Error:', sourcesError.message);
    return;
  }

  // Count by source
  const sourceCounts = {};
  sources?.forEach(s => {
    sourceCounts[s.source] = (sourceCounts[s.source] || 0) + 1;
  });

  console.log('Snapshots by source:');
  Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([source, count]) => {
      console.log(`  ${source}: ${count}`);
    });

  // 2. Check latest captured_at per source
  console.log('\n=== Latest Data Capture Time by Source ===\n');

  for (const source of Object.keys(sourceCounts).slice(0, 15)) {
    const { data: latest } = await supabase
      .from('trader_snapshots')
      .select('captured_at, season_id')
      .eq('source', source)
      .order('captured_at', { ascending: false })
      .limit(1);

    if (latest && latest[0]) {
      const capturedAt = new Date(latest[0].captured_at);
      const hoursAgo = Math.round((Date.now() - capturedAt.getTime()) / (1000 * 60 * 60));
      console.log(`  ${source}: ${hoursAgo}h ago (${latest[0].season_id})`);
    }
  }

  // 3. Check trader_sources
  console.log('\n=== Trader Sources Count ===\n');

  const { count: totalSources } = await supabase
    .from('trader_sources')
    .select('*', { count: 'exact', head: true });

  console.log('Total trader sources:', totalSources);

  // Count by source
  const { data: sourceBreakdown } = await supabase
    .from('trader_sources')
    .select('source')
    .limit(10000);

  const sourceTypeCount = {};
  sourceBreakdown?.forEach(s => {
    sourceTypeCount[s.source] = (sourceTypeCount[s.source] || 0) + 1;
  });

  console.log('\nBreakdown by source:');
  Object.entries(sourceTypeCount)
    .sort((a, b) => b[1] - a[1])
    .forEach(([source, count]) => {
      console.log(`  ${source}: ${count}`);
    });
}

// ---------------------------------------------------------------------------
// --platform: Platform-level freshness (originally check_platform_freshness.mjs)
// ---------------------------------------------------------------------------
async function checkPlatform() {
  console.log('=== Platform Data Freshness Report ===\n');

  // Get distinct sources
  const { data: distinctSources, error: distinctError } = await supabase
    .from('trader_snapshots')
    .select('source')
    .limit(50000);

  if (distinctError) {
    console.log('Error:', distinctError.message);
    return;
  }

  // Get unique sources
  const sourceCounts = {};
  distinctSources?.forEach(r => {
    sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1;
  });

  console.log('Found', Object.keys(sourceCounts).length, 'unique sources\n');

  // Get latest per source
  const results = [];
  for (const source of Object.keys(sourceCounts)) {
    const { data: latest } = await supabase
      .from('trader_snapshots')
      .select('captured_at, season_id')
      .eq('source', source)
      .order('captured_at', { ascending: false })
      .limit(1);

    if (latest && latest[0]) {
      results.push({
        source,
        count: sourceCounts[source],
        latest: latest[0].captured_at,
        season: latest[0].season_id
      });
    }
  }

  // Sort by latest
  results.sort((a, b) => new Date(b.latest) - new Date(a.latest));

  console.log('Platform'.padEnd(20) + ' | Count'.padEnd(8) + ' | Last Update'.padEnd(14) + ' | Season');
  console.log('-'.repeat(65));

  results.forEach(s => {
    const hoursAgo = Math.round((Date.now() - new Date(s.latest).getTime()) / (1000 * 60 * 60));
    const status = hoursAgo <= 4 ? '✓' : hoursAgo <= 12 ? '⚠' : '✗';
    console.log(
      s.source.padEnd(20) + ' | ' +
      String(s.count).padEnd(6) + ' | ' +
      (hoursAgo + 'h ago ' + status).padEnd(12) + ' | ' +
      s.season
    );
  });

  console.log('\n=== Summary ===');
  console.log('Total platforms with data:', results.length);

  const fresh = results.filter(s => {
    const hoursAgo = Math.round((Date.now() - new Date(s.latest).getTime()) / (1000 * 60 * 60));
    return hoursAgo <= 4;
  }).length;

  const stale = results.filter(s => {
    const hoursAgo = Math.round((Date.now() - new Date(s.latest).getTime()) / (1000 * 60 * 60));
    return hoursAgo > 4 && hoursAgo <= 12;
  }).length;

  const veryStale = results.filter(s => {
    const hoursAgo = Math.round((Date.now() - new Date(s.latest).getTime()) / (1000 * 60 * 60));
    return hoursAgo > 12;
  }).length;

  console.log('Fresh (< 4h):', fresh, 'platforms');
  console.log('Stale (4-12h):', stale, 'platforms');
  console.log('Very stale (> 12h):', veryStale, 'platforms');

  // Check expected platforms
  const expectedPlatforms = [
    'binance_futures', 'binance_spot', 'binance_web3',
    'bybit', 'bitget_futures', 'bitget_spot',
    'mexc', 'coinex', 'okx_futures', 'okx_web3',
    'kucoin', 'gmx', 'htx_futures', 'weex',
    'phemex', 'bingx', 'gateio', 'xt', 'pionex',
    'kwenta', 'gains', 'mux', 'lbank', 'blofin'
  ];

  const existingSources = new Set(results.map(r => r.source));
  const missing = expectedPlatforms.filter(p => !existingSources.has(p));

  if (missing.length > 0) {
    console.log('\n=== Missing Platforms ===');
    missing.forEach(p => console.log('  ✗ ' + p));
  }

  // Total count
  const { count } = await supabase
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true });
  console.log('\nTotal snapshots in DB:', count);

  // Calculate success rate based on expected 4-hour update cycle
  const totalExpected = expectedPlatforms.length;
  const recentlyUpdated = results.filter(s => {
    const hoursAgo = Math.round((Date.now() - new Date(s.latest).getTime()) / (1000 * 60 * 60));
    return hoursAgo <= 8; // Within 2 cron cycles
  }).length;

  console.log('\n=== Success Rate Estimate ===');
  console.log('Platforms updated within 8h:', recentlyUpdated + '/' + totalExpected);
  console.log('Estimated success rate:', Math.round((recentlyUpdated / totalExpected) * 100) + '%');
}

// ---------------------------------------------------------------------------
// --detailed: Detailed freshness (originally check_detailed_freshness.mjs)
// ---------------------------------------------------------------------------
async function checkDetailed() {
  // Check all snapshots with date info
  const { data: allSnapshots, error } = await supabase
    .from('trader_snapshots')
    .select('source, season_id, captured_at, roi, rank')
    .order('captured_at', { ascending: false })
    .limit(50);

  if (error) {
    console.log('Error:', error.message);
    return;
  }

  console.log('=== Recent 50 Snapshots ===\n');
  console.log('Source | Season | Rank | ROI | Captured At');
  console.log('-'.repeat(70));

  allSnapshots?.forEach(s => {
    const capturedAt = new Date(s.captured_at);
    const hoursAgo = Math.round((Date.now() - capturedAt.getTime()) / (1000 * 60 * 60));
    const source = (s.source || '').padEnd(16);
    const season = (s.season_id || '').padEnd(4);
    const rank = String(s.rank || '').padEnd(4);
    const roi = String(s.roi?.toFixed(2) || 'N/A').padEnd(8);
    console.log(source + ' | ' + season + ' | ' + rank + ' | ' + roi + ' | ' + hoursAgo + 'h ago');
  });

  // Check total count
  const { count } = await supabase
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true });

  console.log('\n=== Total Snapshots:', count, '===');
}

// ---------------------------------------------------------------------------
// --cron: Cron log check (originally check_cron_logs.mjs)
// ---------------------------------------------------------------------------
async function checkCron() {
  const { data, error } = await supabase
    .from('cron_logs')
    .select('*')
    .order('ran_at', { ascending: false })
    .limit(100);

  if (error) {
    console.log('cron_logs error:', error.message);
    return;
  }

  console.log('Recent cron executions:', data?.length || 0);
  if (data && data.length > 0) {
    let successCount = 0;
    let totalCount = 0;
    const platformStats = {};

    data.forEach(log => {
      try {
        const results = typeof log.result === 'string' ? JSON.parse(log.result) : log.result;
        if (Array.isArray(results)) {
          results.forEach(r => {
            totalCount++;
            if (r.success) successCount++;

            const platform = log.name.replace('fetch-traders-', '');
            if (!platformStats[platform]) {
              platformStats[platform] = { success: 0, total: 0 };
            }
            platformStats[platform].total++;
            if (r.success) platformStats[platform].success++;
          });
        }
      } catch (e) {}
    });

    console.log('\nOverall success rate:', Math.round(successCount/totalCount*100) + '%', '(' + successCount + '/' + totalCount + ')');
    console.log('\nPer platform:');
    Object.entries(platformStats).sort((a,b) => b[1].total - a[1].total).forEach(([p, s]) => {
      console.log('  ' + p + ': ' + Math.round(s.success/s.total*100) + '% (' + s.success + '/' + s.total + ')');
    });

    console.log('\nRecent failures:');
    let failCount = 0;
    data.slice(0, 30).forEach(log => {
      try {
        const results = typeof log.result === 'string' ? JSON.parse(log.result) : log.result;
        if (Array.isArray(results)) {
          results.filter(r => !r.success).forEach(r => {
            failCount++;
            if (failCount <= 15) {
              console.log('  - ' + log.name + ' @ ' + new Date(log.ran_at).toLocaleString() + ': ' + (r.error || 'unknown').substring(0, 100));
            }
          });
        }
      } catch (e) {}
    });
    if (failCount > 15) console.log('  ... and ' + (failCount-15) + ' more failures');
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const runAll = args.includes('--all');
  const runBasic = args.includes('--basic');
  const runPlatform = args.includes('--platform');
  const runDetailed = args.includes('--detailed');
  const runCron = args.includes('--cron');

  // Default to --basic when no flags specified
  const noFlags = !runAll && !runBasic && !runPlatform && !runDetailed && !runCron;

  if (runAll || runBasic || noFlags) {
    console.log('\n>>> Basic Data Freshness <<<\n');
    await checkBasic();
  }

  if (runAll || runPlatform) {
    console.log('\n>>> Platform Freshness <<<\n');
    await checkPlatform();
  }

  if (runAll || runDetailed) {
    console.log('\n>>> Detailed Freshness <<<\n');
    await checkDetailed();
  }

  if (runAll || runCron) {
    console.log('\n>>> Cron Log Check <<<\n');
    await checkCron();
  }
}

main().catch(console.error);
