const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('📊 检查数据库数据...\n');
console.log('Supabase URL:', supabaseUrl);
console.log('Service Key:', supabaseKey ? '✅ 已设置' : '❌ 未设置');

if (!supabaseUrl || !supabaseKey) {
  console.error('\n❌ 缺少Supabase配置');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkData() {
  try {
    // 检查 trader_snapshots 表
    console.log('\n1️⃣ 检查 trader_snapshots 表...');
    const { data: snapshots, error: snapError, count } = await supabase
      .from('trader_snapshots')
      .select('*', { count: 'exact', head: false })
      .limit(5);

    if (snapError) {
      console.error('❌ trader_snapshots 查询失败:', snapError.message);
    } else {
      console.log(`✅ trader_snapshots 总记录数: ${count || 0}`);
      console.log(`   前5条记录: ${snapshots?.length || 0}条`);
      if (snapshots && snapshots.length > 0) {
        console.log('   示例数据:', JSON.stringify(snapshots[0], null, 2).substring(0, 300));
      }
    }

    // 检查有 arena_score 的记录
    console.log('\n2️⃣ 检查有 arena_score 的记录...');
    const { data: scoredSnapshots, error: scoreError, count: scoreCount } = await supabase
      .from('trader_snapshots')
      .select('source, source_trader_id, roi, pnl, arena_score, season_id', { count: 'exact' })
      .not('arena_score', 'is', null)
      .gt('arena_score', 0)
      .order('arena_score', { ascending: false })
      .limit(10);

    if (scoreError) {
      console.error('❌ arena_score 查询失败:', scoreError.message);
    } else {
      console.log(`✅ 有 arena_score 的记录数: ${scoreCount || 0}`);
      console.log('   Top 10:');
      scoredSnapshots?.forEach((s, i) => {
        console.log(`   ${i + 1}. ${s.source}/${s.source_trader_id} - Score: ${s.arena_score}, ROI: ${s.roi}%, Season: ${s.season_id}`);
      });
    }

    // 检查90D season
    console.log('\n3️⃣ 检查 90D season 数据...');
    const { data: season90D, error: season90Error, count: season90Count } = await supabase
      .from('trader_snapshots')
      .select('source, arena_score', { count: 'exact' })
      .eq('season_id', '90D')
      .not('arena_score', 'is', null)
      .gt('arena_score', 0)
      .order('arena_score', { ascending: false })
      .limit(5);

    if (season90Error) {
      console.error('❌ 90D season 查询失败:', season90Error.message);
    } else {
      console.log(`✅ 90D season 有效记录数: ${season90Count || 0}`);
      if (season90D && season90D.length > 0) {
        console.log('   Top 5 sources:', season90D.map(s => s.source).join(', '));
      }
    }

    // 检查 trader_sources 表
    console.log('\n4️⃣ 检查 trader_sources 表...');
    const { data: sources, error: sourcesError, count: sourcesCount } = await supabase
      .from('trader_sources')
      .select('*', { count: 'exact' })
      .limit(3);

    if (sourcesError) {
      console.error('❌ trader_sources 查询失败:', sourcesError.message);
    } else {
      console.log(`✅ trader_sources 总记录数: ${sourcesCount || 0}`);
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('诊断完成 ✅');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (error) {
    console.error('\n❌ 检查失败:', error);
    process.exit(1);
  }
}

checkData();
