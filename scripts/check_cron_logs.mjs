import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://iknktzifjdyujdccyhsv.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
);

async function checkLogs() {
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

checkLogs().catch(console.error);
