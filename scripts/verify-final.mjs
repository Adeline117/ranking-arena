import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ 
    viewport: { width: 1400, height: 800 },
    // 禁用缓存
    bypassCSP: true,
  });
  const page = await context.newPage();
  
  // 清除所有缓存
  await context.clearCookies();
  
  console.log('\n📸 Taking fresh screenshot (cache bypassed)...');
  
  // 添加随机参数绕过 CDN 缓存
  const url = `https://www.arenafi.org/rankings/hyperliquid?_t=${Date.now()}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  
  // 等待数据加载
  await page.waitForTimeout(3000);
  
  await page.screenshot({ 
    path: '/tmp/arena-screenshots/hyperliquid_fresh.png',
    fullPage: false
  });
  console.log('✓ hyperliquid_fresh.png');
  
  // 检查第2名的 handle
  const secondTrader = await page.$eval('[data-testid="trader-row"]:nth-child(2) .trader-name', el => el.textContent).catch(() => null);
  console.log('Second trader handle:', secondTrader || '(not found with selector)');
  
  await browser.close();
})();
