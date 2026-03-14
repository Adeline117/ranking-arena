import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  
  console.log('\n📸 Verifying profanity filter...');
  await page.goto('https://www.arenafi.org/rankings/hyperliquid', { waitUntil: 'networkidle', timeout: 30000 });
  await page.screenshot({ 
    path: '/tmp/arena-screenshots/hyperliquid_after_fix.png',
    fullPage: false
  });
  console.log('✓ hyperliquid_after_fix.png');
  
  await browser.close();
})();
