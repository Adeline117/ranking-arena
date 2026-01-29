import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://iknktzifjdyujdccyhsv.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
);

async function checkFreshness() {
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

checkFreshness().catch(console.error);
