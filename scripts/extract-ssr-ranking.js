const { chromium } = require('playwright');

const URL = 'https://www.arenafi.org/';

async function extract() {
  console.log('📄 提取SSR排行榜内容...\n');
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 800 }
  });
  const page = await context.newPage();

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  
  // 立即检查SSR内容（不等待JS）
  console.log('━━━ SSR阶段检查 ━━━');
  const ssrDiv = await page.locator('#ssr-ranking').innerHTML().catch(() => null);
  if (ssrDiv) {
    console.log('SSR排行榜HTML长度:', ssrDiv.length);
    console.log('SSR内容预览:\n', ssrDiv.substring(0, 2000));
    
    // 检查是否有trader行
    const ssrRows = ssrDiv.match(/class="ssr-row"/g);
    console.log('\nSSR行数:', ssrRows ? ssrRows.length : 0);
  } else {
    console.log('❌ 未找到 #ssr-ranking');
  }

  // 等待客户端hydration
  await page.waitForTimeout(5000);
  
  console.log('\n━━━ 客户端hydration后 ━━━');
  const homeRanking = await page.locator('.home-ranking-section').count();
  console.log('home-ranking-section:', homeRanking);
  
  const clientHTML = await page.locator('main, body').first().innerHTML();
  console.log('客户端HTML长度:', clientHTML.length);
  
  // 检查是否有排行榜数据的各种形式
  const hasTraderLinks = await page.locator('a[href*="/traders/"]').count();
  const hasProfileImages = await page.locator('img[alt*="avatar"], img[alt*="profile"]').count();
  
  console.log('\n━━━ 数据元素检查 ━━━');
  console.log('Trader链接数:', hasTraderLinks);
  console.log('头像图片数:', hasProfileImages);
  
  // 获取所有链接看看
  const links = await page.locator('a').all();
  const traderLinks = [];
  for (const link of links.slice(0, 50)) {
    const href = await link.getAttribute('href');
    if (href && href.includes('/traders/')) {
      traderLinks.push(href);
    }
  }
  console.log('\n找到的Trader链接（前10个）:');
  traderLinks.slice(0, 10).forEach(l => console.log('  -', l));

  await browser.close();
  console.log('\n✅ 提取完成');
}

extract().catch(console.error);
