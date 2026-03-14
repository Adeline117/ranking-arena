import { chromium } from 'playwright';

const urls = [
  'https://www.arenafi.org/rankings/binance_futures',
  'https://www.arenafi.org/rankings/hyperliquid',
  'https://www.arenafi.org/rankings/bybit',
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  
  for (const url of urls) {
    console.log(`\n📸 ${url}`);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      const filename = url.split('/').pop();
      await page.screenshot({ 
        path: `/tmp/arena-screenshots/rankings_${filename}.png`,
        fullPage: false
      });
      console.log(`✓ rankings_${filename}.png`);
    } catch (err) {
      console.error(`❌ ${url}: ${err.message}`);
    }
  }
  
  await browser.close();
})();
