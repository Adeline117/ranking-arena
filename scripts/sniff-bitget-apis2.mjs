#!/usr/bin/env node
import { chromium } from 'playwright';

async function sniff() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await ctx.newPage();
  
  // Track all API calls
  const apiCalls = new Map();
  const reqBodies = new Map();
  page.on('request', req => {
    const url = req.url();
    if (url.includes('bitget.com') && (url.includes('/v1/') || url.includes('/api/'))) {
      try { reqBodies.set(url, req.postData()?.slice(0, 200) || ''); } catch(e) {}
    }
  });
  page.on('response', async r => {
    const url = r.url();
    if (url.includes('bitget.com') && (url.includes('/v1/') || url.includes('/api/'))) {
      const status = r.status();
      try {
        const body = await r.text();
        if (!body.startsWith('<') && body.length > 20) {
          apiCalls.set(url, { status, body: body.slice(0, 2000), reqBody: reqBodies.get(url) });
        }
      } catch(e) {}
    }
  });
  
  // Visit trader detail page
  const traderId = 'b0b046738eb43852a491';
  console.log(`Navigating to trader detail: ${traderId}`);
  await page.goto(`https://www.bitget.com/copy-trading/futures/trade-center/detail?traderId=${traderId}`, {
    waitUntil: 'networkidle', timeout: 40000
  }).catch(e => console.warn('Nav warn:', e.message));
  await page.waitForTimeout(6000);
  
  console.log('\nAll API calls made by trader detail page:');
  for (const [url, { status, body, reqBody }] of apiCalls.entries()) {
    const shortUrl = url.replace('https://www.bitget.com', '');
    if (reqBody) console.log(`  REQ: ${reqBody}`);
    console.log(`\n[${status}] ${shortUrl}`);
    // Only show if has win-related data
    if (body.includes('winRate') || body.includes('maxDrawdown') || body.includes('drawdown') || body.includes('winRatio') || body.includes('profitLossRatio')) {
      console.log('  *** HAS WIN/DRAWDOWN DATA ***');
      console.log(' ', body.slice(0, 800));
    } else {
      try {
        console.log('  (keys):', Object.keys(JSON.parse(body).data || {}).slice(0, 10).join(', ') || body.slice(0, 100));
      } catch(e) {
        console.log(' ', body.slice(0, 100));
      }
    }
  }
  
  // Now try in-page fetch with cookies
  console.log('\n\nTrying in-page API calls with session cookies...');
  const results = await page.evaluate(async (traderId) => {
    const results = {};
    
    const tryFetch = async (name, path, body) => {
      try {
        const r = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'language': 'en_US' },
          body: JSON.stringify(body),
        });
        const text = await r.text();
        results[name] = { status: r.status, body: text.slice(0, 800) };
      } catch(e) {
        results[name] = { error: e.toString() };
      }
    };
    
    await tryFetch('queryTraderPerformance', '/v1/trigger/trace/queryTraderPerformance', { traderId, periodType: '30D' });
    await tryFetch('queryTraderPerformance_ALL', '/v1/trigger/trace/queryTraderPerformance', { traderId, periodType: 'ALL' });
    await tryFetch('traderDetail', '/v1/trigger/trace/public/traderDetail', { triggerUserId: traderId });
    await tryFetch('traderStats', '/v1/trigger/trace/public/traderStats', { triggerUserId: traderId });
    await tryFetch('traderStat', '/v1/trigger/trace/public/traderStat', { triggerUserId: traderId });
    await tryFetch('performance', '/v1/trigger/trace/public/performance', { triggerUserId: traderId });
    await tryFetch('traderKpi', '/v1/trigger/trace/public/traderKpi', { triggerUserId: traderId });
    await tryFetch('publicTraderView', '/v1/trigger/trace/public/traderView', { triggerUserId: traderId });
    await tryFetch('copyMixTraderList', '/v1/copy/mix/trader/list', {
      pageNo: 1, pageSize: 3, cycleTime: 30, sortType: 'roi', productType: 'USDT-FUTURES'
    });
    
    return results;
  }, traderId);
  
  console.log('In-page fetch results:');
  for (const [name, res] of Object.entries(results)) {
    console.log(`\n${name}:`, res.error || `[${res.status}] ${res.body?.slice(0, 300)}`);
  }
  
  await browser.close();
}

sniff().catch(console.error);
