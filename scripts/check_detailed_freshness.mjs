import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://iknktzifjdyujdccyhsv.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
);

async function check() {
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

check().catch(console.error);
