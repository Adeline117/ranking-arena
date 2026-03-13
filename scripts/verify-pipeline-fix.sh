#!/bin/bash
# Quick verification script for Arena Pipeline fix (2026-03-13)

cd "$(dirname "$0")/.."

echo "════════════════════════════════════════════════════════════════"
echo "Arena Pipeline Fix Verification"
echo "Fix deployed: 2026-03-13 09:24 UTC (02:24 PDT)"
echo "════════════════════════════════════════════════════════════════"
echo ""

source .env.local 2>/dev/null || true

npx tsx -e "
import { createClient } from '@supabase/supabase-js';

(async () => {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const deployTime = new Date('2026-03-13T09:24:00Z');
  const now = new Date();
  const hoursSinceDeploy = (now.getTime() - deployTime.getTime()) / (1000 * 60 * 60);

  console.log(\`⏱️  Time since deploy: \${hoursSinceDeploy.toFixed(1)} hours\n\`);

  // Get logs after deployment
  const { data, error } = await supabase
    .from('pipeline_logs')
    .select('*')
    .or('job_name.eq.batch-fetch-traders-a2,job_name.eq.batch-fetch-traders-d2,job_name.ilike.batch-enrich-%')
    .gte('started_at', deployTime.toISOString())
    .order('started_at', { ascending: false });

  if (error) {
    console.error('❌ Query error:', error);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log('⏳ No runs found after deployment yet.\n');
    console.log('Next scheduled runs:');
    console.log('  • batch-fetch-traders-a2: every 3h at :50 (e.g., 09:50, 12:50, 15:50...)');
    console.log('  • batch-fetch-traders-d2: every 6h at :28 (e.g., 12:28, 18:28, 00:28...)');
    console.log('  • batch-enrich-90D: every 4h at :10 (e.g., 10:10, 14:10, 18:10...)');
    console.log('  • batch-enrich-30D: every 4h at :25 (e.g., 10:25, 14:25, 18:25...)');
    console.log('  • batch-enrich-7D: every 4h at :40 (e.g., 10:40, 14:40, 18:40...)');
    console.log('');
    console.log('💡 Run this script again after the next scheduled run.');
    return;
  }

  // Group by job name
  const byJob = new Map<string, typeof data>();
  data.forEach(log => {
    if (!byJob.has(log.job_name)) byJob.set(log.job_name, []);
    byJob.get(log.job_name)!.push(log);
  });

  console.log(\`📊 Found \${data.length} runs across \${byJob.size} job types\n\`);

  // Summary stats
  let totalSuccess = 0;
  let totalFailed = 0;

  byJob.forEach((logs, jobName) => {
    const latest = logs[0];
    const icon = latest.status === 'success' ? '✅' : '❌';
    const success = logs.filter(l => l.status === 'success').length;
    const failed = logs.length - success;

    totalSuccess += success;
    totalFailed += failed;

    console.log(\`\${icon} \${jobName}\`);
    console.log(\`   Runs: \${logs.length} (\${success} success, \${failed} failed)\`);
    console.log(\`   Latest: \${latest.status} at \${new Date(latest.started_at).toISOString()}\`);
    console.log(\`   Duration: \${Math.round(latest.duration_ms / 1000)}s\`);

    if (latest.error_message) {
      console.log(\`   Error: \${latest.error_message}\`);
    }

    if (latest.metadata?.results) {
      const results = latest.metadata.results;
      const platformSuccess = results.filter((r: any) => r.status === 'success').length;
      console.log(\`   Platforms: \${platformSuccess}/\${results.length} success\`);

      // Show platform details for enrichment jobs
      if (jobName.includes('batch-enrich')) {
        const dydxResult = results.find((r: any) => r.platform === 'dydx');
        if (dydxResult) {
          const dydxIcon = dydxResult.status === 'success' ? '✅' : '⚠️';
          const dydxTime = Math.round(dydxResult.durationMs / 1000);
          console.log(\`   dydx: \${dydxIcon} \${dydxResult.status} (\${dydxTime}s, enriched=\${dydxResult.enriched || 0})\`);
        }
      }
    }

    console.log('');
  });

  console.log('════════════════════════════════════════════════════════════════');
  console.log(\`Overall: \${totalSuccess} success, \${totalFailed} failed\`);

  const successRate = ((totalSuccess / (totalSuccess + totalFailed)) * 100).toFixed(1);
  console.log(\`Success rate: \${successRate}%\`);

  if (totalFailed === 0) {
    console.log('🎉 All jobs passing! Fix successful!');
  } else {
    console.log('⚠️  Some jobs still failing. See details above.');
  }
})();
"
