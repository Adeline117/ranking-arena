/* eslint-disable */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = 'https://www.arenafi.org';
const SCREENSHOT_DIR = '/tmp/arena-screenshots';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const platforms = [
  'binance_futures', 'binance_spot', 'okx_futures', 'hyperliquid', 
  'dydx', 'bitfinex', 'etoro', 'gains', 'drift', 'bybit',
  'bitget_futures', 'mexc', 'jupiter_perps', 'aevo', 'gmx',
  'htx_futures', 'bitunix', 'bingx', 'toobit', 'phemex',
  'blofin', 'coinex', 'okx_web3', 'btcc', 'web3_bot'
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  
  const results = [];
  
  // 1. Check Overall homepage leaderboard
  console.log('=== Checking Homepage ===');
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '00-homepage.png'), fullPage: false });
  
  // Check if homepage has multiple platforms
  const homeText = await page.textContent('body');
  const hasBinance = homeText.includes('Binance') || homeText.includes('binance');
  const hasHyperliquid = homeText.includes('Hyperliquid') || homeText.includes('hyperliquid');
  console.log('Homepage has Binance:', hasBinance, '| Hyperliquid:', hasHyperliquid);
  
  // 2. Check each platform ranking page
  for (const platform of platforms) {
    console.log(`\n=== Checking ${platform} ===`);
    try {
      const url = `${BASE}/rankings/${platform}`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(1500);
      
      // Screenshot ranking page
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `01-${platform}-rankings.png`), fullPage: false });
      
      // Check for data presence
      const bodyText = await page.textContent('body');
      const hasNoData = bodyText.includes('No data') || bodyText.includes('No traders') || bodyText.includes('暂无数据');
      const hasTable = await page.locator('table, [class*="trader"], [class*="ranking"]').count();
      
      // Check for ROI values (numbers like 12.34% or -5.67%)
      const roiMatch = bodyText.match(/[\-]?\d+\.\d+%/g);
      const roiCount = roiMatch?.length || 0;
      
      // Check for score values
      const scoreMatch = bodyText.match(/\b\d{1,2}\.\d{1,2}\b/g);
      
      const status = hasNoData ? '❌ NO DATA' : (roiCount > 0 ? '✅ HAS DATA' : '⚠️ CHECK');
      console.log(`  ${status} | table elements: ${hasTable} | ROI values: ${roiCount}`);
      results.push({ platform, status, hasTable, roiCount, hasNoData });
      
      // Click first trader to check detail page
      if (!hasNoData && hasTable > 0) {
        try {
          // Find first clickable trader link
          const traderLink = page.locator('a[href*="/trader/"]').first();
          if (await traderLink.count() > 0) {
            const href = await traderLink.getAttribute('href');
            console.log(`  Navigating to trader: ${href}`);
            await traderLink.click();
            await page.waitForLoadState('networkidle', { timeout: 15000 });
            await page.waitForTimeout(1500);
            
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, `02-${platform}-trader-detail.png`), fullPage: false });
            
            const detailText = await page.textContent('body');
            const hasNoPerf = detailText.includes('No performance data') || detailText.includes('暂无表现数据');
            const hasScore = detailText.match(/Arena Score/i);
            const detailROI = detailText.match(/ROI.*[\-]?\d+\.\d+/);
            
            const detailStatus = hasNoPerf ? '❌ NO PERF' : '✅ OK';
            console.log(`  Detail: ${detailStatus} | Score: ${hasScore ? 'YES' : 'NO'} | ROI: ${detailROI ? 'YES' : 'NO'}`);
          }
        } catch (e) {
          console.log(`  Detail page error: ${e.message.substring(0, 80)}`);
        }
      }
    } catch (e) {
      console.log(`  ❌ ERROR: ${e.message.substring(0, 80)}`);
      results.push({ platform, status: '❌ ERROR', error: e.message.substring(0, 80) });
    }
  }
  
  // 3. Check search
  console.log('\n=== Checking Search ===');
  try {
    await page.goto(`${BASE}/rankings`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1000);
    
    // Look for search input
    const searchInput = page.locator('input[type="search"], input[placeholder*="Search"], input[placeholder*="搜索"]').first();
    if (await searchInput.count() > 0) {
      await searchInput.fill('SSS888');
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-search-result.png') });
      const searchText = await page.textContent('body');
      console.log('Search "SSS888":', searchText.includes('SSS888') ? '✅ Found' : '⚠️ Not found');
    } else {
      console.log('No search input found on rankings page');
    }
  } catch (e) {
    console.log(`Search error: ${e.message.substring(0, 80)}`);
  }
  
  // Summary
  console.log('\n\n=== SUMMARY ===');
  results.forEach(r => console.log(`${r.status} ${r.platform} (table:${r.hasTable}, roi:${r.roiCount})`));
  
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
