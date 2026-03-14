import { chromium } from 'playwright';

const pages = [
  'https://www.arenafi.org/',
  'https://www.arenafi.org/rankings/binance_futures',
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  
  for (const url of pages) {
    const name = url.replace('https://www.arenafi.org', '').replace(/\//g, '_') || 'home';
    console.log(`\n📸 ${url}`);
    await page.goto(url + `?_t=${Date.now()}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ 
      path: `/tmp/arena-screenshots/round2_${name}.png`,
      fullPage: false
    });
    console.log(`✓ round2_${name}.png`);
  }
  
  await browser.close();
})();
