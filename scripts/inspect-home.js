const { chromium } = require('playwright');

const URL = 'https://www.arenafi.org/';

async function inspect() {
  console.log('🔍 深度检查首页DOM结构...\n');
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 800 }
  });
  const page = await context.newPage();

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(5000); // 等待客户端渲染

  // 检查各种可能的排行榜元素
  const checks = [
    { selector: 'table', desc: 'table 元素' },
    { selector: 'table tbody tr', desc: 'table 行' },
    { selector: '[role="table"]', desc: 'role=table' },
    { selector: '[role="row"]', desc: 'role=row' },
    { selector: '[data-testid*="trader"]', desc: 'trader data-testid' },
    { selector: '.ranking', desc: '.ranking 类' },
    { selector: 'text=/ROI|PnL|Score/i', desc: 'ROI/PnL/Score 文本' },
    { selector: 'text=/回报率|盈亏|得分/i', desc: '中文指标' }
  ];

  console.log('━━━ 元素计数 ━━━');
  for (const check of checks) {
    const count = await page.locator(check.selector).count();
    console.log(`${check.desc.padEnd(25)} : ${count}`);
  }

  // 获取页面文本内容
  console.log('\n━━━ 页面文本内容（前500字符）━━━');
  const bodyText = await page.locator('body').textContent();
  console.log(bodyText?.substring(0, 500).trim());

  // 检查是否有加载指示器
  const hasLoading = await page.locator('text=/loading|加载中/i').count();
  console.log(`\n━━━ 加载状态 ━━━`);
  console.log(`Loading 指示器: ${hasLoading > 0 ? '有' : '无'}`);

  // 获取HTML结构
  console.log('\n━━━ 主要容器HTML（前1000字符）━━━');
  const mainHTML = await page.locator('main, [role="main"], .main, #main').first().innerHTML().catch(() => '未找到main容器');
  console.log(mainHTML.substring(0, 1000));

  await browser.close();
  console.log('\n✅ 检查完成');
}

inspect().catch(console.error);
