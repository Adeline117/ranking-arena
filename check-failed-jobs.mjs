import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Check recent failed jobs
const { data, error } = await supabase
  .from('pipeline_logs')
  .select('id, job_name, started_at, ended_at, status, records_processed, error_message, metadata')
  .eq('status', 'error')
  .gte('started_at', new Date(Date.now() - 24*60*60*1000).toISOString())
  .order('started_at', { ascending: false })
  .limit(15);

if (error) {
  console.error('Error:', error);
} else {
  console.log('📋 Recent failed jobs (last 24h):', data.length);
  for (const job of data) {
    console.log(`\n${job.job_name} (${new Date(job.started_at).toLocaleString()})`);
    console.log(`  Status: ${job.status} | Records: ${job.records_processed}`);
    console.log(`  Error: ${job.error_message}`);
    if (job.metadata?.results) {
      console.log('  Failed platforms:', job.metadata.results.filter(r => r.status === 'error').map(r => r.platform).join(', '));
    }
  }
}
