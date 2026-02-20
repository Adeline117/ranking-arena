#!/usr/bin/env node
import { chromium } from 'playwright';

async function sniff() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  
  const captured = [];
  page.on('response', async r => {
    const url = r.url();
    if (url.includes('/v1/') || url.includes('/api/') || url.includes('/copy/')) {
      const status = r.status();
      if (status === 200) {
        try {
          const body = await r.text();
          if (body.includes('winRate') || body.includes('maxDrawdown') || body.includes('drawdown') || body.includes('winRatio') || body.includes('profitLossRatio')) {
            captured.push({ url, body: body.slice(0, 600) });
          }
        } catch(e) {}
      }
    }
  });
  
  // Visit copy trading futures
  console.log('Navigating to Bitget copy trading futures...');
  await page.goto('https://www.bitget.com/copy-trading/futures', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.warn(e.message));
  await page.waitForTimeout(5000);
  
  // Also intercept via in-page fetch for trader list
  console.log('Fetching trader list via in-page fetch...');
  const traderListResp = await page.evaluate(async () => {
    try {
      const r = await fetch('/v1/copy/mix/trader/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageNo: 1, pageSize: 5, cycleTime: 30, sortType: 'roi', productType: 'USDT-FUTURES' }),
      });
      const text = await r.text();
      return { status: r.status, body: text.slice(0, 1000) };
    } catch(e) {
      return { error: e.toString() };
    }
  });
  console.log('Trader list response:', JSON.stringify(traderListResp));
  
  // Try traderView endpoint
  const traderViewResp = await page.evaluate(async () => {
    try {
      const r = await fetch('/v1/trigger/trace/public/uta/traderView', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triggerUserId: 'b0b046738eb43852a491' }),
      });
      const text = await r.text();
      return { status: r.status, body: text.slice(0, 1000) };
    } catch(e) {
      return { error: e.toString() };
    }
  });
  console.log('TraderView response:', JSON.stringify(traderViewResp));

  // Try queryTraderPerformance
  const perfResp = await page.evaluate(async () => {
    try {
      const r = await fetch('/v1/trigger/trace/queryTraderPerformance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ traderId: 'b0b046738eb43852a491', periodType: '30D' }),
      });
      const text = await r.text();
      return { status: r.status, body: text.slice(0, 1000) };
    } catch(e) {
      return { error: e.toString() };
    }
  });
  console.log('queryTraderPerformance response:', JSON.stringify(perfResp));
  
  // Try the detail page for a trader
  console.log('\nNavigating to trader detail page...');
  await page.goto('https://www.bitget.com/copy-trading/futures/trade-center/detail?traderId=b0b046738eb43852a491', {
    waitUntil: 'domcontentloaded', timeout: 30000
  }).catch(e => console.warn(e.message));
  await page.waitForTimeout(5000);
  
  console.log('\nCaptured API calls with win_rate/max_drawdown keywords:');
  captured.forEach(c => {
    console.log('URL:', c.url);
    console.log('Body:', c.body);
    console.log('---');
  });
  
  // Also try in-page fetches on trader detail page
  const detailResp = await page.evaluate(async () => {
    const traderId = 'b0b046738eb43852a491';
    const results = {};
    
    const endpoints = [
      { name: 'queryTraderPerformance', path: '/v1/trigger/trace/queryTraderPerformance', body: { traderId, periodType: '30D' } },
      { name: 'traderView', path: '/v1/trigger/trace/public/uta/traderView', body: { triggerUserId: traderId } },
      { name: 'cycleData', path: '/v1/trigger/trace/public/cycleData', body: { triggerUserId: traderId, cycleTime: 30 } },
      { name: 'traderInfo', path: '/v1/trigger/trace/public/traderInfo', body: { triggerUserId: traderId } },
      { name: 'overview', path: '/v1/trigger/trace/public/overview', body: { triggerUserId: traderId } },
    ];
    
    for (const ep of endpoints) {
      try {
        const r = await fetch(ep.path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ep.body),
        });
        const text = await r.text();
        results[ep.name] = { status: r.status, body: text.slice(0, 500) };
      } catch(e) {
        results[ep.name] = { error: e.toString() };
      }
    }
    return results;
  });
  
  console.log('\nDetail page in-page fetch results:');
  Object.entries(detailResp).forEach(([name, res]) => {
    console.log(`\n${name}:`, JSON.stringify(res));
  });
  
  await browser.close();
}

sniff().catch(console.error);
