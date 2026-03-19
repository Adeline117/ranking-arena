/* eslint-disable */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = 'https://www.arenafi.org';
const DIR = '/tmp/arena-screenshots';

// Test a subset of platforms - click first trader and check detail page
const platforms = [
  'binance_futures', 'okx_futures', 'hyperliquid', 'etoro', 
  'bybit', 'drift', 'bitfinex', 'gmx', 'mexc', 'jupiter_perps'
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  
  for (const platform of platforms) {
    console.log(`\n=== ${platform} - Trader Detail ===`);
    try {
      await page.goto(`${BASE}/rankings/${platform}`, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(1500);
      
      const traderLink = page.locator('a[href*="/trader/"]').first();
      if (await traderLink.count() > 0) {
        const href = await traderLink.getAttribute('href');
        console.log(`  Link: ${href}`);
        await page.goto(`${BASE}${href}`, { waitUntil: 'networkidle', timeout: 20000 });
        await page.waitForTimeout(2000);
        
        await page.screenshot({ path: path.join(DIR, `03-${platform}-detail.png`), fullPage: false });
        
        const text = await page.textContent('body');
        const hasNoPerf = text.includes('No performance data') || text.includes('暂无表现数据');
        const hasScore = /Arena Score/i.test(text);
        const hasROI = /ROI/i.test(text);
        const scoreVal = text.match(/Arena Score[^0-9]*(\d+)/i);
        const roiVal = text.match(/ROI[^0-9]*([+-]?\d+[\d,.]*%?)/i);
        
        console.log(`  No Perf: ${hasNoPerf}`);
        console.log(`  Score: ${scoreVal ? scoreVal[1] : 'NOT FOUND'}`);
        console.log(`  ROI mention: ${hasROI}`);
        
        // Check for "—" dashes indicating missing data
        const dashes = (text.match(/—/g) || []).length;
        console.log(`  Dash count: ${dashes}`);
      } else {
        console.log('  No trader links found');
      }
    } catch (e) {
      console.log(`  ERROR: ${e.message.substring(0, 100)}`);
    }
  }
  
  // Also check search
  console.log('\n=== Search Test ===');
  await page.goto(`${BASE}`, { waitUntil: 'networkidle', timeout: 20000 });
  const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="搜索"]').first();
  if (await searchInput.count() > 0) {
    await searchInput.click();
    await page.waitForTimeout(500);
    await searchInput.fill('SSS888');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(DIR, '04-search-sss888.png') });
    
    // Try clicking on first search result
    const resultLink = page.locator('a[href*="/trader/"]').first();
    if (await resultLink.count() > 0) {
      await resultLink.click();
      await page.waitForLoadState('networkidle', { timeout: 15000 });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(DIR, '05-search-result-detail.png') });
      console.log('Search result detail page captured');
    }
  }
  
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
