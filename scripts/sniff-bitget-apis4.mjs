#!/usr/bin/env node
import { chromium } from 'playwright';

async function sniff() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await ctx.newPage();
  
  console.log('Navigating to copy-trading/futures...');
  await page.goto('https://www.bitget.com/copy-trading/futures', {
    waitUntil: 'domcontentloaded', timeout: 30000
  }).catch(e => console.warn(e.message));
  await page.waitForTimeout(3000);
  
  const results = await page.evaluate(async () => {
    const out = {};
    
    // 1. Get traderList first page - full structure
    try {
      const r = await fetch('/v1/trigger/trace/public/traderList', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ languageType: 0, productType: 'USDT-FUTURES', cycleTime: 30, pageNo: 1, pageSize: 3 }),
      });
      const data = await r.json();
      const rows = data?.data?.rows || [];
      if (rows.length > 0) {
        out.traderList_firstRow_keys = Object.keys(rows[0]);
        out.traderList_firstRow = rows[0];
      }
      out.traderList_status = r.status;
      out.traderList_code = data?.code;
    } catch(e) { out.traderList_error = e.toString(); }
    
    // 2. cycleData for a specific trader - check full statisticsDTO
    try {
      const r = await fetch('/v1/trigger/trace/public/cycleData', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ languageType: 0, triggerUserId: 'b0b046738eb43852a491', cycleTime: 30 }),
      });
      const data = await r.json();
      out.cycleData_statisticsDTO = data?.data?.statisticsDTO;
      out.cycleData_keys = data?.data ? Object.keys(data.data) : [];
    } catch(e) { out.cycleData_error = e.toString(); }
    
    // 3. Try traderList with 90d
    try {
      const r = await fetch('/v1/trigger/trace/public/traderList', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ languageType: 0, productType: 'USDT-FUTURES', cycleTime: 90, pageNo: 1, pageSize: 2 }),
      });
      const data = await r.json();
      const rows = data?.data?.rows || [];
      out.traderList90_firstRow_keys = rows[0] ? Object.keys(rows[0]) : [];
    } catch(e) { out.traderList90_error = e.toString(); }
    
    // 4. Try a search/detail endpoint for specific trader
    try {
      const r = await fetch('/v1/trigger/trace/public/traderList', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ languageType: 0, productType: 'USDT-FUTURES', cycleTime: 30, pageNo: 1, pageSize: 1, sortType: 'roi', traderUid: 'b0b046738eb43852a491' }),
      });
      const data = await r.json();
      out.traderList_byUid = { code: data?.code, rows: data?.data?.rows?.length };
    } catch(e) { out.traderList_byUid_error = e.toString(); }
    
    return out;
  });
  
  console.log('\ntraderList first row keys:', results.traderList_firstRow_keys);
  console.log('\ntraderList first row (full):');
  // Look for win_rate and drawdown fields
  const row = results.traderList_firstRow;
  if (row) {
    // Print all fields that might relate to win/drawdown/performance
    for (const [k, v] of Object.entries(row)) {
      if (typeof v !== 'object' || v === null) {
        console.log(`  ${k}: ${v}`);
      } else {
        console.log(`  ${k}: [${Array.isArray(v) ? 'array:' + v.length : 'object'}]`, JSON.stringify(v).slice(0, 200));
      }
    }
  }
  
  console.log('\ncycleData statisticsDTO keys:', results.cycleData_statisticsDTO ? Object.keys(results.cycleData_statisticsDTO) : 'null');
  console.log('cycleData statisticsDTO:', JSON.stringify(results.cycleData_statisticsDTO, null, 2));
  console.log('\ncycleData top-level keys:', results.cycleData_keys);
  
  console.log('\ntraderList by UID:', results.traderList_byUid);
  
  await browser.close();
}

sniff().catch(console.error);
