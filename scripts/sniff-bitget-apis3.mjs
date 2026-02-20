#!/usr/bin/env node
import { chromium } from 'playwright';

async function sniff() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await ctx.newPage();
  
  // First navigate to the copy trading futures page to get session
  console.log('Navigating to copy-trading/futures...');
  await page.goto('https://www.bitget.com/copy-trading/futures', {
    waitUntil: 'domcontentloaded', timeout: 30000
  }).catch(e => console.warn(e.message));
  await page.waitForTimeout(4000);
  
  // Try topTraders endpoint  
  const topTradersResp = await page.evaluate(async () => {
    try {
      const r = await fetch('/v1/trigger/trace/public/topTraders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ languageType: 0, productType: 'USDT-FUTURES', cycleTime: 30 }),
      });
      const text = await r.text();
      return { status: r.status, body: text };
    } catch(e) { return { error: e.toString() }; }
  });
  
  if (topTradersResp.body) {
    try {
      const parsed = JSON.parse(topTradersResp.body);
      console.log('topTraders code:', parsed.code);
      const rows = parsed.data?.rows || [];
      console.log('rows count:', rows.length);
      if (rows.length > 0) {
        console.log('\nFirst row keys:', Object.keys(rows[0]));
        console.log('\nFirst row full:', JSON.stringify(rows[0], null, 2));
      }
    } catch(e) {
      console.log('topTraders response:', topTradersResp.body.slice(0, 1000));
    }
  }
  
  // Also try the traderView endpoint from copy-trading page (not detail)
  console.log('\n\nTrying traderView from copy-trading/futures page...');
  const tvResp = await page.evaluate(async () => {
    try {
      const r = await fetch('/v1/trigger/trace/public/uta/traderView', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triggerUserId: 'b0b046738eb43852a491' }),
      });
      return { status: r.status, body: await r.text() };
    } catch(e) { return { error: e.toString() }; }
  });
  console.log('traderView:', tvResp.status, tvResp.body?.slice(0, 300));
  
  // Try the list endpoint with different params
  console.log('\n\nTrying various list endpoints...');
  const listResp = await page.evaluate(async () => {
    const results = {};
    const endpoints = [
      { name: 'topTraders_7d', body: { languageType: 0, productType: 'USDT-FUTURES', cycleTime: 7 } },
      { name: 'topTraders_30d', body: { languageType: 0, productType: 'USDT-FUTURES', cycleTime: 30 } },
      { name: 'topTraders_90d', body: { languageType: 0, productType: 'USDT-FUTURES', cycleTime: 90 } },
      { name: 'traderList_v2', path: '/v1/trigger/trace/public/traderList', body: { languageType: 0, productType: 'USDT-FUTURES', cycleTime: 30, pageNo: 1, pageSize: 5 } },
      { name: 'allTraders', path: '/v1/trigger/trace/public/allTraders', body: { languageType: 0, productType: 'USDT-FUTURES', cycleTime: 30, pageNo: 1, pageSize: 5 } },
    ];
    
    for (const ep of endpoints) {
      try {
        const r = await fetch(ep.path || '/v1/trigger/trace/public/topTraders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ep.body),
        });
        const text = await r.text();
        results[ep.name] = { status: r.status, body: text.slice(0, 200) };
      } catch(e) { results[ep.name] = { error: e.toString() }; }
    }
    return results;
  });
  
  for (const [name, res] of Object.entries(listResp)) {
    console.log(`\n${name}: [${res.status || 'ERR'}]`, res.error || res.body?.slice(0, 150));
  }
  
  await browser.close();
}

sniff().catch(console.error);
