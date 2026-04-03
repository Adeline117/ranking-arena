/**
 * 测试BITGET平台导入 - 快速诊断版
 */

import 'dotenv/config';

const SCRAPER = process.env.VPS_SCRAPER_HOST || 'http://45.76.152.169:3457';
const API_KEY = 'arena-proxy-sg-2026';
const TIMEOUT = 180000; // 3 minutes

async function testBitget() {
  console.log('====================================');
  console.log('BITGET 导入测试');
  console.log(`Scraper: ${SCRAPER}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log('====================================\n');
  
  const endpoint = '/bitget/leaderboard';
  const params = { pageNo: 1, pageSize: 100, period: 'THIRTY_DAYS', type: 'futures' };
  
  const url = new URL(endpoint, SCRAPER);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  
  console.log(`请求URL: ${url.toString()}\n`);
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);
  
  try {
    const startTime = Date.now();
    console.log('发送请求...');
    
    const res = await fetch(url.toString(), {
      headers: { 'x-proxy-key': API_KEY },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(`\n响应状态: ${res.status} ${res.statusText}`);
    console.log(`耗时: ${elapsed}秒`);
    console.log(`Content-Type: ${res.headers.get('content-type')}`);
    
    if (!res.ok) {
      const text = await res.text();
      console.log(`\n错误响应:\n${text.substring(0, 500)}`);
      process.exit(1);
    }
    
    const data = await res.json();
    console.log(`\n返回数据结构:`);
    console.log(`  code: ${data.code}`);
    console.log(`  msg: ${data.msg || 'N/A'}`);
    console.log(`  data: ${data.data ? 'exists' : 'null'}`);
    
    if (data.data?.traderList) {
      console.log(`  traderList: ${data.data.traderList.length} traders`);
      
      if (data.data.traderList.length > 0) {
        const first = data.data.traderList[0];
        console.log(`\n第一条数据示例:`);
        console.log(`  nickName: ${first.nickName}`);
        console.log(`  traderUid: ${first.traderUid}`);
        console.log(`  profitRate: ${first.profitRate}`);
        console.log(`  totalProfit: ${first.totalProfit}`);
        console.log(`  followerCount: ${first.followerCount}`);
      }
      
      console.log(`\n✅ BITGET导入测试成功！`);
      console.log(`   获取到 ${data.data.traderList.length} 条数据`);
    } else {
      console.log(`\n⚠️  数据格式异常:`);
      console.log(JSON.stringify(data, null, 2).substring(0, 1000));
    }
    
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`\n❌ 请求失败: ${err.message}`);
    console.error(`   错误类型: ${err.name}`);
    if (err.cause) {
      console.error(`   原因: ${err.cause}`);
    }
    process.exit(1);
  }
}

testBitget().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
