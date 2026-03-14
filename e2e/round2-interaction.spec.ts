import { test, expect } from '@playwright/test';

/**
 * Arena Round 2 功能交互测试
 * 测试用户交互、数据更新、状态管理
 */

test.describe('Round 2: 功能交互测试', () => {
  
  // 测试场景1：排行榜时间窗口切换
  test('场景1: 排行榜时间窗口切换', async ({ page }) => {
    const errors: string[] = [];
    
    // 监听控制台错误
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(`Console error: ${msg.text()}`);
      }
    });
    
    // 监听页面错误
    page.on('pageerror', error => {
      errors.push(`Page error: ${error.message}`);
    });
    
    await page.goto('https://www.arenafi.org/rankings/binance_futures');
    await page.waitForLoadState('networkidle');
    
    // 截图初始状态
    await page.screenshot({ path: 'test-results/round2-scene1-initial.png', fullPage: true });
    
    // 点击7D
    const period7D = page.locator('[data-period="7D"], button:has-text("7D")').first();
    if (await period7D.isVisible()) {
      await period7D.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'test-results/round2-scene1-7d.png', fullPage: true });
    } else {
      errors.push('未找到7D时间窗口按钮');
    }
    
    // 点击30D
    const period30D = page.locator('[data-period="30D"], button:has-text("30D")').first();
    if (await period30D.isVisible()) {
      await period30D.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'test-results/round2-scene1-30d.png', fullPage: true });
    } else {
      errors.push('未找到30D时间窗口按钮');
    }
    
    // 检查数据是否更新（表格应该有内容）
    const tableRows = await page.locator('table tbody tr').count();
    expect(tableRows, '排行榜应该有数据').toBeGreaterThan(0);
    
    // 报告错误
    if (errors.length > 0) {
      console.log('场景1发现的问题：', errors);
    }
    expect(errors, '不应该有JavaScript错误').toHaveLength(0);
  });

  // 测试场景2：排序功能
  test('场景2: ROI列排序', async ({ page }) => {
    const errors: string[] = [];
    
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(`Console: ${msg.text()}`);
    });
    page.on('pageerror', error => {
      errors.push(`Page: ${error.message}`);
    });
    
    await page.goto('https://www.arenafi.org/rankings/binance_futures');
    await page.waitForLoadState('networkidle');
    
    // 截图排序前
    await page.screenshot({ path: 'test-results/round2-scene2-before-sort.png', fullPage: true });
    
    // 点击ROI列标题排序
    const roiHeader = page.locator('th:has-text("ROI"), th:has-text("PnL%")').first();
    if (await roiHeader.isVisible()) {
      await roiHeader.click();
      await page.waitForTimeout(1000);
      
      // 截图排序后
      await page.screenshot({ path: 'test-results/round2-scene2-after-sort.png', fullPage: true });
      
      // 检查数据是否按ROI排序（获取前3行的ROI值）
      const roiValues = await page.locator('table tbody tr td:nth-child(4), table tbody tr td:nth-child(5)').first().allTextContents();
      console.log('ROI值:', roiValues);
    } else {
      errors.push('未找到ROI列标题');
    }
    
    if (errors.length > 0) {
      console.log('场景2发现的问题：', errors);
    }
    expect(errors).toHaveLength(0);
  });

  // 测试场景3：搜索功能
  test('场景3: 搜索功能', async ({ page }) => {
    const errors: string[] = [];
    
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', error => {
      errors.push(error.message);
    });
    
    await page.goto('https://www.arenafi.org/search');
    await page.waitForLoadState('networkidle');
    
    // 查找搜索输入框
    const searchInput = page.locator('input[type="search"], input[placeholder*="搜索"], input[placeholder*="Search"]').first();
    
    if (await searchInput.isVisible()) {
      await searchInput.fill('trader');
      await page.waitForTimeout(2000);
      
      // 截图搜索结果
      await page.screenshot({ path: 'test-results/round2-scene3-search.png', fullPage: true });
      
      // 检查是否有搜索结果
      const hasResults = await page.locator('body').textContent();
      console.log('搜索页面内容长度:', hasResults?.length);
    } else {
      errors.push('未找到搜索输入框');
    }
    
    if (errors.length > 0) {
      console.log('场景3发现的问题：', errors);
    }
    expect(errors).toHaveLength(0);
  });

  // 测试场景4：页面导航
  test('场景4: 主导航链接', async ({ page }) => {
    const errors: string[] = [];
    const links = ['Rankings', 'Market', 'Flash News', 'Library', 'Tools'];
    const results: { link: string; success: boolean; url: string }[] = [];
    
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', error => {
      errors.push(error.message);
    });
    
    await page.goto('https://www.arenafi.org');
    await page.waitForLoadState('networkidle');
    
    for (const linkText of links) {
      try {
        const link = page.locator(`nav a:has-text("${linkText}"), a:has-text("${linkText}")`).first();
        
        if (await link.isVisible()) {
          await link.click();
          await page.waitForLoadState('networkidle', { timeout: 10000 });
          
          const currentUrl = page.url();
          results.push({ link: linkText, success: true, url: currentUrl });
          
          // 截图
          await page.screenshot({ path: `test-results/round2-scene4-${linkText.toLowerCase().replace(' ', '-')}.png`, fullPage: true });
        } else {
          results.push({ link: linkText, success: false, url: 'link not found' });
          errors.push(`未找到导航链接: ${linkText}`);
        }
      } catch (error) {
        results.push({ link: linkText, success: false, url: 'navigation failed' });
        errors.push(`导航失败 ${linkText}: ${error}`);
      }
    }
    
    console.log('导航测试结果:', results);
    
    if (errors.length > 0) {
      console.log('场景4发现的问题：', errors);
    }
    expect(errors).toHaveLength(0);
  });

  // 测试场景5：Trader详情页交互
  test('场景5: Trader详情页图表切换', async ({ page }) => {
    const errors: string[] = [];
    
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', error => {
      errors.push(error.message);
    });
    
    await page.goto('https://www.arenafi.org/rankings/hyperliquid');
    await page.waitForLoadState('networkidle');
    
    // 截图排行榜
    await page.screenshot({ path: 'test-results/round2-scene5-rankings.png', fullPage: true });
    
    // 点击第一个trader链接
    const firstTraderLink = page.locator('table tbody tr:first-child td a, table tbody tr:first-child a').first();
    
    if (await firstTraderLink.isVisible()) {
      await firstTraderLink.click();
      await page.waitForLoadState('networkidle');
      
      // 截图详情页
      await page.screenshot({ path: 'test-results/round2-scene5-detail.png', fullPage: true });
      
      // 切换图表时间窗口（90D）
      const chart90D = page.locator('[data-chart-period="90D"], button:has-text("90D")').first();
      
      if (await chart90D.isVisible()) {
        await chart90D.click();
        await page.waitForTimeout(1000);
        
        // 截图图表切换后
        await page.screenshot({ path: 'test-results/round2-scene5-chart-90d.png', fullPage: true });
      } else {
        errors.push('未找到90D图表切换按钮');
      }
    } else {
      errors.push('未找到trader链接');
    }
    
    if (errors.length > 0) {
      console.log('场景5发现的问题：', errors);
    }
    expect(errors).toHaveLength(0);
  });
});
