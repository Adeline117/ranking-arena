/* eslint-disable */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = 'https://www.arenafi.org';
const DIR = '/tmp/arena-screenshots';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
  const page = await context.newPage();
  
  // 1. Homepage - scroll down to see more platforms
  console.log('=== Homepage Overall Leaderboard ===');
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  
  // Get all platform labels visible
  const bodyText = await page.textContent('body');
  const platforms = ['Binance', 'OKX', 'Bybit', 'Hyperliquid', 'Bitget', 'MEXC', 'GMX', 'dYdX', 'Drift', 'eToro', 'Aevo'];
  console.log('Homepage platform mentions:');
  platforms.forEach(p => {
    console.log(`  ${p}: ${bodyText.includes(p) ? '✅' : '❌'}`);
  });
  
  // Full page screenshot
  await page.screenshot({ path: path.join(DIR, '10-homepage-full.png'), fullPage: true });
  
  // 2. Scroll down on homepage to see traders beyond top 5
  await page.evaluate(() => window.scrollBy(0, 800));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(DIR, '11-homepage-scrolled.png') });
  
  // Check if homepage traders are from multiple platforms
  const traderRows = await page.locator('a[href*="/trader/"]').all();
  const platformSet = new Set();
  for (const row of traderRows.slice(0, 20)) {
    const href = await row.getAttribute('href');
    const match = href?.match(/platform=(\w+)/);
    if (match) platformSet.add(match[1]);
  }
  console.log('Homepage trader platforms:', [...platformSet]);
  
  // 3. Search for SSS888
  console.log('\n=== Search Test ===');
  const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="搜索"], input[placeholder*="search"]').first();
  if (await searchInput.count() > 0) {
    await searchInput.click();
    await page.waitForTimeout(500);
    await searchInput.fill('SSS888');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(DIR, '12-search-sss888.png') });
    
    // Click search result
    const result = page.locator('a[href*="/trader/"]').first();
    if (await result.count() > 0) {
      const href = await result.getAttribute('href');
      console.log('Search result link:', href);
      await result.click();
      await page.waitForTimeout(3000);
      await page.screenshot({ path: path.join(DIR, '13-search-detail.png') });
      
      const detailText = await page.textContent('body');
      console.log('Detail has Score:', /Arena Score/.test(detailText));
      console.log('Detail has ROI:', /ROI/.test(detailText));
      console.log('Detail has PNL:', /PNL|PnL/.test(detailText));
    }
  }
  
  // 4. Check dydx now (after fix deployed)
  console.log('\n=== dYdX Check (post-deploy) ===');
  await page.goto(`${BASE}/rankings/dydx`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, '14-dydx-rankings.png') });
  const dydxText = await page.textContent('body');
  console.log('dYdX shows "Exchange Not Found":', dydxText.includes('Exchange Not Found'));
  console.log('dYdX has ROI values:', /[\-]?\d+\.\d+%/.test(dydxText));
  
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
