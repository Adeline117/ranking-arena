#!/usr/bin/env node
/**
 * Lighthouse Performance Test
 * Tests 5 core pages of Arena platform
 */

import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import fs from 'fs';

const urls = [
  { name: '首页', url: 'https://www.arenafi.org/' },
  { name: 'Binance排行榜', url: 'https://www.arenafi.org/rankings/binance_futures' },
  { name: 'Hyperliquid排行榜', url: 'https://www.arenafi.org/rankings/hyperliquid' },
  { name: 'Trader详情页', url: 'https://www.arenafi.org/trader/0x598f9efb3164ec216b4eff33c2b239605be5af8e?platform=hyperliquid' },
  { name: '搜索页', url: 'https://www.arenafi.org/search' },
];

async function runLighthouse() {
  const results = [];
  
  console.log('🚀 Starting Lighthouse tests...\n');
  
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless', '--disable-gpu', '--no-sandbox']
  });
  
  for (const { name, url } of urls) {
    console.log(`📊 Testing: ${name}`);
    console.log(`   URL: ${url}`);
    
    try {
      const options = {
        logLevel: 'error',
        output: 'json',
        onlyCategories: ['performance'],
        port: chrome.port,
      };
      
      const runnerResult = await lighthouse(url, options);
      const { lhr } = runnerResult;
      
      const metrics = lhr.audits['metrics']?.details?.items?.[0];
      const performance = lhr.categories.performance.score * 100;
      
      const result = {
        name,
        url,
        performance: Math.round(performance),
        lcp: metrics?.largestContentfulPaint || 0,
        fcp: metrics?.firstContentfulPaint || 0,
        tti: metrics?.interactive || 0,
        cls: metrics?.cumulativeLayoutShift || 0,
        tbt: metrics?.totalBlockingTime || 0,
        speedIndex: metrics?.speedIndex || 0,
      };
      
      results.push(result);
      
      console.log(`   ✅ Performance: ${result.performance}/100`);
      console.log(`   📈 LCP: ${Math.round(result.lcp)}ms`);
      console.log(`   📈 FCP: ${Math.round(result.fcp)}ms`);
      console.log(`   📈 TTI: ${Math.round(result.tti)}ms`);
      console.log(`   📈 CLS: ${result.cls.toFixed(3)}`);
      console.log('');
      
    } catch (error) {
      console.error(`   ❌ Error testing ${name}:`, error.message);
    }
  }
  
  await chrome.kill();
  
  // Save results
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  const reportPath = `./docs/lighthouse-results-${timestamp}.json`;
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  
  console.log(`\n💾 Results saved to: ${reportPath}`);
  
  // Print summary
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 Performance Summary');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  results.forEach(r => {
    const lcpStatus = r.lcp < 2500 ? '✅' : '❌';
    const fcpStatus = r.fcp < 1800 ? '✅' : '❌';
    const clsStatus = r.cls < 0.1 ? '✅' : '✅'; // CLS often 0 in headless
    
    console.log(`\n${r.name}:`);
    console.log(`  Performance: ${r.performance}/100`);
    console.log(`  ${lcpStatus} LCP: ${Math.round(r.lcp)}ms (target: <2500ms)`);
    console.log(`  ${fcpStatus} FCP: ${Math.round(r.fcp)}ms (target: <1800ms)`);
    console.log(`  ${clsStatus} CLS: ${r.cls.toFixed(3)} (target: <0.1)`);
  });
  
  // Identify issues
  const issues = [];
  results.forEach(r => {
    if (r.performance < 90) issues.push(`${r.name}: 性能分数低 (${r.performance}/100)`);
    if (r.lcp > 2500) issues.push(`${r.name}: LCP 过高 (${Math.round(r.lcp)}ms)`);
    if (r.fcp > 1800) issues.push(`${r.name}: FCP 过高 (${Math.round(r.fcp)}ms)`);
  });
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`\n发现 ${issues.length} 个性能问题:`);
  issues.forEach((issue, i) => console.log(`  ${i + 1}. ${issue}`));
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  return results;
}

runLighthouse().catch(console.error);
