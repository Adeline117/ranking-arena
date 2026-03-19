import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://iknktzifjdyujdccyhsv.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkBitgetLogs() {
  console.log('查询 bitget_futures 的最近 pipeline 日志...\n');
  
  const { data, error } = await supabase
    .from('pipeline_logs')
    .select('*')
    .eq('job_name', 'enrich-bitget_futures')
    .order('started_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('查询错误:', error);
    return;
  }

  if (!data || data.length === 0) {
    console.log('❌ 没有找到 bitget_futures 的日志');
    return;
  }

  console.log(`✅ 找到 ${data.length} 条日志:\n`);

  for (const log of data) {
    const startedAt = new Date(log.started_at);
    const endedAt = log.ended_at ? new Date(log.ended_at) : null;
    const durationSec = endedAt 
      ? (endedAt.getTime() - startedAt.getTime()) / 1000
      : (Date.now() - startedAt.getTime()) / 1000;

    console.log('═══════════════════════════════════════════════════════');
    console.log(`开始时间: ${startedAt.toISOString()}`);
    console.log(`结束时间: ${endedAt ? endedAt.toISOString() : '未完成'}`);
    console.log(`持续时间: ${durationSec.toFixed(1)} 秒 (${(durationSec / 60).toFixed(1)} 分钟)`);
    console.log(`状态: ${log.status || 'unknown'}`);
    console.log(`错误: ${log.error_message || '无'}`);
    
    if (log.metadata) {
      console.log('\nMetadata:');
      console.log(JSON.stringify(log.metadata, null, 2));
    }
    console.log('');
  }
}

checkBitgetLogs().catch(console.error);
