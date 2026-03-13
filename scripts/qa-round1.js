const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// 检查是否有本地开发服务器，否则使用生产环境
const BASE_URL = process.env.QA_URL || 'http://localhost:3000';

const PAGES = [
  { name: 'home', url: '/', desc: '首页' },
  { name: 'binance', url: '/rankings/binance_futures', desc: 'Binance排行榜' },
  { name: 'okx', url: '/rankings/okx_futures', desc: 'OKX排行榜' },
  { name: 'hyperliquid', url: '/rankings/hyperliquid', desc: 'Hyperliquid排行榜' },
  { name: 'trader-detail', url: '/traders/hyperliquid/0x1234', desc: 'Trader详情页' }
];

const VIEWPORTS = [
  { name: 'desktop', width: 1400, height: 800 },
  { name: 'mobile', width: 375, height: 800 }
];

const OUTPUT_DIR = path.join(__dirname, 'screenshots/round-001');

// 确保输出目录存在
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const consoleErrors = [];
const pageIssues = [];

async function captureScreenshots() {
  console.log(`🚀 开始QA Round 1 - 数据显示诊断`);
  console.log(`📍 目标URL: ${BASE_URL}`);
  console.log(`📸 输出目录: ${OUTPUT_DIR}\n`);

  const browser = await chromium.launch({ headless: true });
  let totalScreenshots = 0;

  for (const viewport of VIEWPORTS) {
    console.log(`\n📱 ${viewport.name} (${viewport.width}x${viewport.height})`);
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      userAgent: viewport.name === 'mobile' 
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15'
        : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });

    const page = await context.newPage();

    // 监听控制台错误
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push({
          viewport: viewport.name,
          page: 'unknown',
          message: msg.text()
        });
      }
    });

    // 监听页面错误
    page.on('pageerror', error => {
      consoleErrors.push({
        viewport: viewport.name,
        page: 'unknown',
        message: error.message
      });
    });

    for (const pageInfo of PAGES) {
      const url = `${BASE_URL}${pageInfo.url}`;
      console.log(`  ↳ ${pageInfo.desc}: ${url}`);

      try {
        await page.goto(url, { 
          waitUntil: 'networkidle',
          timeout: 30000 
        });

        // 等待一下让内容渲染
        await page.waitForTimeout(2000);

        const filename = `${pageInfo.name}_${viewport.name}.png`;
        const filepath = path.join(OUTPUT_DIR, filename);
        
        await page.screenshot({ 
          path: filepath,
          fullPage: false
        });
        
        totalScreenshots++;
        console.log(`    ✅ ${filename}`);

        // 检查数据显示（维度1）
        await checkDataDisplay(page, pageInfo, viewport.name);

      } catch (error) {
        console.error(`    ❌ 截图失败: ${error.message}`);
        pageIssues.push({
          page: pageInfo.desc,
          viewport: viewport.name,
          issue: `截图失败: ${error.message}`
        });
      }
    }

    await context.close();
  }

  await browser.close();

  // 生成报告
  generateReport(totalScreenshots);
}

async function checkDataDisplay(page, pageInfo, viewportName) {
  const issues = [];

  try {
    // 首页使用SSR，快速检查而不等太久
    if (pageInfo.name === 'home') {
      // 检查SSR排行榜
      const ssrRows = await page.locator('.ssr-row').count();
      // 检查客户端排行榜
      await page.waitForTimeout(3000);
      const clientTraders = await page.locator('a[href*="/traders/"]').count();
      const totalRows = Math.max(ssrRows, clientTraders);
      
      if (totalRows === 0) {
        issues.push('排行榜无数据（空表格）');
      } else {
        console.log(`    ℹ️  找到 ${totalRows} 行数据 (SSR: ${ssrRows}, 客户端: ${clientTraders})`);
        // 检查是否有指标
        const hasMetrics = await page.locator('text=/ROI|PnL|Score|回报率/i').count() > 0;
        if (!hasMetrics) {
          issues.push('未找到ROI/PnL/Score指标');
        }
      }
      return;
    }

    // 排行榜页面
    if (pageInfo.name.includes('rankings')) {
      // 等待数据加载
      await page.waitForTimeout(3000);
      
      // 尝试多种选择器
      const tableRows = await page.locator('table tbody tr').count();
      const traderLinks = await page.locator('a[href*="/traders/"]').count();
      const totalRows = Math.max(tableRows, traderLinks);
      
      if (totalRows === 0) {
        issues.push('排行榜无数据');
      } else {
        console.log(`    ℹ️  找到 ${totalRows} 行数据`);
        // 检查是否有ROI/PnL/Score数字
        const hasMetrics = await page.locator('text=/ROI|PnL|Score|回报率/i').count() > 0;
        if (!hasMetrics) {
          issues.push('未找到ROI/PnL/Score指标');
        }
      }
    }

    // 检查Trader详情页
    if (pageInfo.name === 'trader-detail') {
      // 这个URL是测试用的，可能不存在，不报错
      const hasErrorMsg = await page.locator('text=/not found|404|error/i').count() > 0;
      if (hasErrorMsg) {
        console.log(`    ℹ️  Trader详情页: 测试ID不存在 (预期行为)`);
        return; // 不记录为问题
      }

      const hasChart = await page.locator('canvas').count() > 0;
      if (!hasChart) {
        issues.push('Trader详情页未找到图表canvas元素');
      }

      const hasData = await page.locator('text=/PnL|ROI|Trades/i').count() > 0;
      if (!hasData) {
        issues.push('Trader详情页未找到数据指标');
      }
    }

  } catch (error) {
    issues.push(`数据检查失败: ${error.message}`);
  }

  if (issues.length > 0) {
    pageIssues.push({
      page: pageInfo.desc,
      viewport: viewportName,
      issues: issues
    });
  }
}

function generateReport(totalScreenshots) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Round 1 — 维度1：数据显示');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`\n📸 截图完成: ${totalScreenshots}个页面`);
  
  console.log(`\n🔍 发现问题: ${pageIssues.length}个`);
  if (pageIssues.length > 0) {
    pageIssues.forEach((issue, idx) => {
      console.log(`\n  ${idx + 1}. ${issue.page} [${issue.viewport}]`);
      if (issue.issues) {
        issue.issues.forEach(i => console.log(`     - ${i}`));
      } else if (issue.issue) {
        console.log(`     - ${issue.issue}`);
      }
    });
  } else {
    console.log('  ✅ 无明显数据显示问题');
  }

  if (consoleErrors.length > 0) {
    console.log(`\n⚠️  控制台错误: ${consoleErrors.length}条`);
    consoleErrors.slice(0, 5).forEach((error, idx) => {
      console.log(`  ${idx + 1}. [${error.viewport}] ${error.message.substring(0, 100)}`);
    });
    if (consoleErrors.length > 5) {
      console.log(`  ... 还有${consoleErrors.length - 5}条错误`);
    }
  }

  console.log('\n📋 修复完成: 0个');
  console.log('   （尚未修复，等待分析）');
  
  console.log('\n🎯 下一步: 分析截图并修复发现的问题');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 保存详细报告到JSON
  const reportPath = path.join(OUTPUT_DIR, 'qa-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    totalScreenshots,
    pageIssues,
    consoleErrors: consoleErrors.slice(0, 20)
  }, null, 2));
  console.log(`📄 详细报告: ${reportPath}\n`);
}

// 运行
captureScreenshots().catch(error => {
  console.error('❌ 脚本执行失败:', error);
  process.exit(1);
});
