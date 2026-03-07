/**
 * Arena 全平台数据源完整测试
 * 测试所有25+个平台的健康状态和数据获取能力
 * 
 * Usage: npx tsx scripts/test-all-platforms.ts
 */

import { getAllConnectorKeys, getConnector } from '../connectors';
import type { Platform, MarketType, Window } from '../connectors/base/types';
import fs from 'fs';
import path from 'path';

interface PlatformTestResult {
  platform: string;
  marketType: string;
  status: '✅ healthy' | '⚠️ degraded' | '❌ failed';
  responseTime: number;
  dataCount: number;
  lastSuccess: string | null;
  error: string | null;
  details: {
    supportsROISort?: boolean;
    windows?: Window[];
    sampleData?: any;
  };
}

const NEW_SCRAPERS = ['bybit', 'mexc', 'htx'];
const TEST_WINDOW: Window = '7d';
const TEST_LIMIT = 10;

async function testPlatform(platform: Platform, marketType: MarketType): Promise<PlatformTestResult> {
  const startTime = Date.now();
  const result: PlatformTestResult = {
    platform,
    marketType,
    status: '❌ failed',
    responseTime: 0,
    dataCount: 0,
    lastSuccess: null,
    error: null,
    details: {},
  };

  try {
    const connector = getConnector(platform, marketType);
    
    if (!connector) {
      result.error = 'Connector not found';
      return result;
    }

    // Test leaderboard discovery
    console.log(`   Testing ${platform}:${marketType}...`);
    const leaderboardResult = await connector.discoverLeaderboard(TEST_WINDOW, TEST_LIMIT);
    
    const responseTime = Date.now() - startTime;
    result.responseTime = responseTime;

    if (leaderboardResult.success && leaderboardResult.data && leaderboardResult.data.length > 0) {
      result.status = '✅ healthy';
      result.dataCount = leaderboardResult.data.length;
      result.lastSuccess = new Date().toISOString();
      
      // Get sample data
      result.details.sampleData = leaderboardResult.data.slice(0, 3).map(entry => ({
        traderKey: entry.trader_key,
        displayName: entry.display_name,
        profileUrl: entry.profile_url,
      }));

      // Try to fetch profile for first trader
      if (leaderboardResult.data[0]) {
        try {
          const profileResult = await connector.fetchTraderSnapshot(
            leaderboardResult.data[0].trader_key,
            TEST_WINDOW
          );
          if (profileResult.success && profileResult.data) {
            result.details.windows = [profileResult.data.window];
          }
        } catch (profileError) {
          // Profile fetch optional
          console.log(`      Profile fetch failed (optional): ${profileError}`);
        }
      }

    } else if (!leaderboardResult.success) {
      result.status = '❌ failed';
      result.error = leaderboardResult.error || 'Unknown error';
    } else if (!leaderboardResult.data || leaderboardResult.data.length === 0) {
      result.status = '⚠️ degraded';
      result.error = 'No data returned';
    }

  } catch (error: any) {
    result.status = '❌ failed';
    result.error = error.message || String(error);
    result.responseTime = Date.now() - startTime;
  }

  return result;
}

async function main() {
  console.log('🧪 Arena 全平台数据源完整测试\n');
  console.log('=' .repeat(80));
  console.log('\n📊 测试配置:');
  console.log(`   Window: ${TEST_WINDOW}`);
  console.log(`   Limit: ${TEST_LIMIT}`);
  console.log(`   Total Platforms: ${getAllConnectorKeys().length}`);
  console.log('\n' + '='.repeat(80) + '\n');

  const allConnectorKeys = getAllConnectorKeys();
  const results: PlatformTestResult[] = [];

  // Group 1: 新开发的爬虫（Bybit/MEXC/HTX）优先测试
  console.log('🎯 第1组: 新开发的爬虫 (Bybit/MEXC/HTX)\n');
  const newScraperKeys = allConnectorKeys.filter(key => {
    const [platform] = key.split(':');
    return NEW_SCRAPERS.includes(platform);
  });

  for (const key of newScraperKeys) {
    const [platform, marketType] = key.split(':') as [Platform, MarketType];
    const result = await testPlatform(platform, marketType);
    results.push(result);
    console.log(`   ${result.status} ${platform}:${marketType} (${result.responseTime}ms, ${result.dataCount} traders)`);
    if (result.error) {
      console.log(`      Error: ${result.error}`);
    }
  }

  console.log('\n' + '='.repeat(80) + '\n');

  // Group 2: 其他所有平台
  console.log('📊 第2组: 所有其他平台\n');
  const otherKeys = allConnectorKeys.filter(key => {
    const [platform] = key.split(':');
    return !NEW_SCRAPERS.includes(platform) && !key.endsWith(':enrichment');
  });

  for (const key of otherKeys) {
    const [platform, marketType] = key.split(':') as [Platform, MarketType];
    const result = await testPlatform(platform, marketType);
    results.push(result);
    console.log(`   ${result.status} ${platform}:${marketType} (${result.responseTime}ms, ${result.dataCount} traders)`);
    if (result.error) {
      console.log(`      Error: ${result.error}`);
    }
  }

  console.log('\n' + '='.repeat(80) + '\n');

  // 生成统计报告
  const healthyCount = results.filter(r => r.status === '✅ healthy').length;
  const degradedCount = results.filter(r => r.status === '⚠️ degraded').length;
  const failedCount = results.filter(r => r.status === '❌ failed').length;
  const avgResponseTime = results.reduce((sum, r) => sum + r.responseTime, 0) / results.length;
  const totalDataCount = results.reduce((sum, r) => sum + r.dataCount, 0);

  console.log('📈 测试统计:\n');
  console.log(`   总平台数: ${results.length}`);
  console.log(`   ✅ 健康: ${healthyCount} (${((healthyCount / results.length) * 100).toFixed(1)}%)`);
  console.log(`   ⚠️  降级: ${degradedCount} (${((degradedCount / results.length) * 100).toFixed(1)}%)`);
  console.log(`   ❌ 失败: ${failedCount} (${((failedCount / results.length) * 100).toFixed(1)}%)`);
  console.log(`   平均响应时间: ${avgResponseTime.toFixed(0)}ms`);
  console.log(`   总数据量: ${totalDataCount} traders`);

  console.log('\n' + '='.repeat(80) + '\n');

  // 新爬虫详细报告
  console.log('🎯 新爬虫详细报告 (Bybit/MEXC/HTX):\n');
  const newScraperResults = results.filter(r => NEW_SCRAPERS.includes(r.platform));
  
  for (const result of newScraperResults) {
    console.log(`\n${result.status} ${result.platform}:${result.marketType}`);
    console.log(`   响应时间: ${result.responseTime}ms`);
    console.log(`   数据量: ${result.dataCount} traders`);
    console.log(`   最后成功: ${result.lastSuccess || 'N/A'}`);
    
    if (result.error) {
      console.log(`   ❌ 错误: ${result.error}`);
    }
    
    if (result.details.sampleData) {
      console.log(`   样本数据:`);
      result.details.sampleData.forEach((sample: any, idx: number) => {
        console.log(`      ${idx + 1}. ${sample.displayName || sample.traderKey}`);
        console.log(`         Key: ${sample.traderKey}`);
        console.log(`         URL: ${sample.profileUrl || 'N/A'}`);
      });
    }
  }

  console.log('\n' + '='.repeat(80) + '\n');

  // 问题平台列表
  const problematicPlatforms = results.filter(r => r.status !== '✅ healthy');
  if (problematicPlatforms.length > 0) {
    console.log('⚠️  问题平台列表:\n');
    for (const result of problematicPlatforms) {
      console.log(`   ${result.status} ${result.platform}:${result.marketType}`);
      console.log(`      错误: ${result.error || 'Unknown'}`);
      console.log(`      响应时间: ${result.responseTime}ms`);
      console.log('');
    }
  }

  console.log('='.repeat(80) + '\n');

  // 保存完整报告
  const reportPath = path.join(process.cwd(), 'test-results', `platform-test-${Date.now()}.json`);
  const reportDir = path.dirname(reportPath);
  
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      total: results.length,
      healthy: healthyCount,
      degraded: degradedCount,
      failed: failedCount,
      avgResponseTime,
      totalDataCount,
    },
    newScrapers: newScraperResults,
    allResults: results,
    problematicPlatforms,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`✅ 完整报告已保存: ${reportPath}\n`);

  // 生成 Markdown 报告
  const mdReportPath = path.join(process.cwd(), 'test-results', `PLATFORM_TEST_REPORT_${new Date().toISOString().split('T')[0]}.md`);
  const mdReport = generateMarkdownReport(report);
  fs.writeFileSync(mdReportPath, mdReport);
  console.log(`📝 Markdown 报告已保存: ${mdReportPath}\n`);

  // 返回状态码
  if (failedCount > results.length * 0.3) {
    console.error('❌ 测试失败: 超过30%的平台失败');
    process.exit(1);
  } else if (failedCount > 0) {
    console.warn('⚠️  部分平台失败，但整体健康');
    process.exit(0);
  } else {
    console.log('✅ 所有平台测试通过！');
    process.exit(0);
  }
}

function generateMarkdownReport(report: any): string {
  const md: string[] = [];
  
  md.push('# Arena 平台数据源测试报告\n');
  md.push(`**生成时间**: ${report.timestamp}\n`);
  md.push('---\n');
  
  md.push('## 📊 总体统计\n');
  md.push(`- **总平台数**: ${report.summary.total}`);
  md.push(`- **✅ 健康**: ${report.summary.healthy} (${((report.summary.healthy / report.summary.total) * 100).toFixed(1)}%)`);
  md.push(`- **⚠️ 降级**: ${report.summary.degraded} (${((report.summary.degraded / report.summary.total) * 100).toFixed(1)}%)`);
  md.push(`- **❌ 失败**: ${report.summary.failed} (${((report.summary.failed / report.summary.total) * 100).toFixed(1)}%)`);
  md.push(`- **平均响应时间**: ${report.summary.avgResponseTime.toFixed(0)}ms`);
  md.push(`- **总数据量**: ${report.summary.totalDataCount} traders\n`);
  
  md.push('---\n');
  md.push('## 🎯 新开发爬虫测试 (Bybit/MEXC/HTX)\n');
  
  for (const result of report.newScrapers) {
    md.push(`### ${result.status} ${result.platform}:${result.marketType}\n`);
    md.push(`- **响应时间**: ${result.responseTime}ms`);
    md.push(`- **数据量**: ${result.dataCount} traders`);
    md.push(`- **最后成功**: ${result.lastSuccess || 'N/A'}`);
    
    if (result.error) {
      md.push(`- **错误**: ${result.error}`);
    }
    
    if (result.details.sampleData) {
      md.push('\n**样本数据**:');
      result.details.sampleData.forEach((sample: any, idx: number) => {
        md.push(`${idx + 1}. ${sample.displayName || sample.traderKey}`);
        md.push(`   - Trader Key: \`${sample.traderKey}\``);
        md.push(`   - Profile URL: ${sample.profileUrl || 'N/A'}`);
      });
    }
    md.push('');
  }
  
  md.push('---\n');
  md.push('## 📋 所有平台状态\n');
  md.push('| Platform | Market Type | Status | Response Time | Data Count | Error |\n');
  md.push('|----------|-------------|--------|---------------|------------|-------|\n');
  
  for (const result of report.allResults) {
    md.push(`| ${result.platform} | ${result.marketType} | ${result.status} | ${result.responseTime}ms | ${result.dataCount} | ${result.error || '-'} |`);
  }
  md.push('');
  
  if (report.problematicPlatforms.length > 0) {
    md.push('---\n');
    md.push('## ⚠️ 问题平台详情\n');
    
    for (const result of report.problematicPlatforms) {
      md.push(`### ${result.platform}:${result.marketType}\n`);
      md.push(`- **状态**: ${result.status}`);
      md.push(`- **错误**: ${result.error || 'Unknown'}`);
      md.push(`- **响应时间**: ${result.responseTime}ms\n`);
    }
  }
  
  md.push('---\n');
  md.push('## 🔧 建议修复措施\n');
  
  const failedPlatforms = report.problematicPlatforms.filter((r: any) => r.status === '❌ failed');
  const degradedPlatforms = report.problematicPlatforms.filter((r: any) => r.status === '⚠️ degraded');
  
  if (failedPlatforms.length > 0) {
    md.push('### 失败平台 (需要立即修复)\n');
    for (const result of failedPlatforms) {
      md.push(`- **${result.platform}:${result.marketType}**`);
      md.push(`  - 错误: ${result.error}`);
      md.push(`  - 建议: 检查 API endpoint、认证配置、网络连接`);
    }
    md.push('');
  }
  
  if (degradedPlatforms.length > 0) {
    md.push('### 降级平台 (需要优化)\n');
    for (const result of degradedPlatforms) {
      md.push(`- **${result.platform}:${result.marketType}**`);
      md.push(`  - 问题: ${result.error}`);
      md.push(`  - 建议: 优化查询参数、检查数据可用性`);
    }
    md.push('');
  }
  
  return md.join('\n');
}

main().catch((error) => {
  console.error('❌ 测试脚本失败:', error);
  process.exit(1);
});
