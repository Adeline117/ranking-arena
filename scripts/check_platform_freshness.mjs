import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://iknktzifjdyujdccyhsv.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
);

async function checkPlatformFreshness() {
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

checkPlatformFreshness().catch(console.error);
