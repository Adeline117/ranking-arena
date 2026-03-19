import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://iknktzifjdyujdccyhsv.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkRecent() {
  console.log('查询 bitget_futures 最近24小时的日志...\n');
  
  const oneDayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  
  const { data, error } = await supabase
    .from('pipeline_logs')
    .select('*')
    .eq('job_name', 'enrich-bitget_futures')
    .gte('started_at', oneDayAgo)
    .order('started_at', { ascending: false });

  if (error) {
    console.error('查询错误:', error);
    return;
  }

  if (!data || data.length === 0) {
    console.log('✅ 最近24小时没有 bitget_futures enrichment 运行');
    return;
  }

  console.log(`找到 ${data.length} 条最近24小时的日志:\n`);

  for (const log of data) {
    const startedAt = new Date(log.started_at);
    const endedAt = log.ended_at ? new Date(log.ended_at) : null;
    const durationSec = endedAt 
      ? (endedAt.getTime() - startedAt.getTime()) / 1000
      : (Date.now() - startedAt.getTime()) / 1000;

    const status = log.status === 'success' ? '✅' : log.status === 'error' ? '❌' : '⏳';
    console.log(`${status} ${startedAt.toISOString()} | ${log.status} | ${durationSec.toFixed(0)}s`);
    if (log.error_message) console.log(`   错误: ${log.error_message}`);
    if (log.metadata && Object.keys(log.metadata).length > 0) {
      console.log(`   Metadata: ${JSON.stringify(log.metadata)}`);
    }
    console.log('');
  }
}

checkRecent().catch(console.error);
