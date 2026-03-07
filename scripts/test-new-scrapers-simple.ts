/**
 * 简单测试新开发的Bybit/MEXC/HTX scraper
 */

import { BybitConnector } from '../connectors/bybit';
import { MexcConnector } from '../connectors/mexc';
import { HtxConnector } from '../connectors/htx';

async function testConnector(name: string, connector: any) {
  console.log(`\n🧪 Testing ${name}...`);
  console.log('='.repeat(60));
  
  try {
    const result = await connector.discoverLeaderboard('7d', 5);
    
    if (result.success && result.data && result.data.length > 0) {
      console.log(`✅ SUCCESS - Got ${result.data.length} traders`);
      console.log(`\nTop 3 traders:`);
      result.data.slice(0, 3).forEach((trader: any, idx: number) => {
        console.log(`  ${idx + 1}. ${trader.display_name || trader.trader_key}`);
        console.log(`     ROI: ${trader.metrics.roi_pct}%`);
        console.log(`     Followers: ${trader.metrics.followers || 'N/A'}`);
      });
    } else {
      console.log(`⚠️  WARNING - No data returned`);
      console.log(`   Success: ${result.success}`);
      console.log(`   Error: ${result.error || 'N/A'}`);
      console.log(`   Quality Flags: ${JSON.stringify(result.quality_flags)}`);
    }
  } catch (error: any) {
    console.log(`❌ ERROR - ${error.message}`);
    console.log(`   Stack: ${error.stack?.split('\n').slice(0, 3).join('\n')}`);
  }
}

async function main() {
  console.log('🚀 Testing New Scrapers (Bybit/MEXC/HTX)\n');
  
  await testConnector('Bybit', new BybitConnector());
  await testConnector('MEXC', new MexcConnector());
  await testConnector('HTX', new HtxConnector());
  
  console.log('\n' + '='.repeat(60));
  console.log('✅ All tests completed!\n');
}

main().catch(console.error);
