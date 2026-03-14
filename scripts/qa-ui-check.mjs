import { chromium } from 'playwright';

const pages = [
  { url: 'https://www.arenafi.org/', name: 'home' },
  { url: 'https://www.arenafi.org/rankings/binance_futures', name: 'rankings_binance' },
  { url: 'https://www.arenafi.org/trader/0x598f9efb3164ec216b4eff33c2b239605be5af8e?platform=hyperliquid', name: 'trader_detail' },
  { url: 'https://www.arenafi.org/market', name: 'market' },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  
  for (const { url, name } of pages) {
    // Desktop
    let page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
    console.log(`\n📸 ${name} (desktop)`);
    await page.goto(url + `?_t=${Date.now()}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ 
      path: `/tmp/arena-screenshots/ui_${name}_desktop.png`,
      fullPage: false
    });
    console.log(`✓ ui_${name}_desktop.png`);
    await page.close();
    
    // Mobile
    page = await browser.newPage({ viewport: { width: 375, height: 800 } });
    console.log(`📱 ${name} (mobile)`);
    await page.goto(url + `?_t=${Date.now()}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ 
      path: `/tmp/arena-screenshots/ui_${name}_mobile.png`,
      fullPage: false
    });
    console.log(`✓ ui_${name}_mobile.png`);
    await page.close();
  }
  
  await browser.close();
  console.log('\n✅ UI screenshots complete');
})();
