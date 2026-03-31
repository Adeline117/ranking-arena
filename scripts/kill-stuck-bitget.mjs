import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://iknktzifjdyujdccyhsv.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function killStuckJob() {
  console.log('查找stuck job...');
  
  const { data: jobs, error: findError } = await supabase
    .from('pipeline_logs')
    .select('*')
    .eq('job_name', 'enrich-bitget_futures')
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1);

  if (findError) {
    console.error('查询错误:', findError);
    return;
  }

  if (!jobs || jobs.length === 0) {
    console.log('✅ 没有找到running状态的job');
    return;
  }

  const stuckJob = jobs[0];
  const startedAt = new Date(stuckJob.started_at);
  const durationMin = (Date.now() - startedAt.getTime()) / 1000 / 60;
  
  console.log(`\n发现stuck job:`);
  console.log(`  ID: ${stuckJob.id}`);
  console.log(`  Started: ${startedAt.toISOString()}`);
  console.log(`  Duration: ${durationMin.toFixed(1)} minutes`);
  console.log(`  Period: ${stuckJob.metadata?.period}`);
  
  const { error: updateError } = await supabase
    .from('pipeline_logs')
    .update({
      status: 'timeout',
      ended_at: new Date().toISOString(),
      error_message: `Killed manually - stuck for ${durationMin.toFixed(1)} minutes (timeout should be <3min)`
    })
    .eq('id', stuckJob.id);

  if (updateError) {
    console.error('❌ 更新失败:', updateError);
  } else {
    console.log(`\n✅ Job已被kill并标记为failed`);
  }
}

killStuckJob().catch(console.error);
