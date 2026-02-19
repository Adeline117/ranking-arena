/**
 * Gate.io enrichment v2: Intercept API from copy trading list pages
 * Navigate through different time ranges and pagination to collect trader stats
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  // Get null WR rows
  let nullRows = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id')
      .eq('source', 'gateio').is('win_rate', null)
      .range(from, from + 999);
    if (!data?.length) break;
    nullRows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const neededIds = new Set(nullRows.map(r => r.source_trader_id));
  console.log(`Gate.io: ${nullRows.length} null rows, ${neededIds.size} unique traders needed`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });

  const traderData = new Map(); // leader_id -> { win_rate, trades_count, max_drawdown }
  const idMapping = new Map(); // various ID forms -> canonical ID

  const page = await context.newPage();

  // Intercept ALL API responses
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('gate.') || res.status() !== 200) return;
    
    // Look for copy trading API responses
    if (url.includes('copy') || url.includes('leader') || url.includes('copytrade')) {
      try {
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        const j = await res.json();
        
        // Gate.io API typically returns {code: 0, data: {list: [...]}}
        let list = null;
        if (j?.data?.list) list = j.data.list;
        else if (j?.data?.rows) list = j.data.rows;
        else if (Array.isArray(j?.data)) list = j.data;
        else if (j?.list) list = j.list;
        
        if (!list || !Array.isArray(list)) return;
        
        for (const t of list) {
          const leaderId = String(t.leader_id || t.leaderId || t.id || t.user_id || t.userId || '');
          if (!leaderId) continue;
          
          const wr = t.win_rate ?? t.winRate ?? t.win_ratio ?? t.winRatio;
          const tc = t.order_count ?? t.orderCount ?? t.trade_count ?? t.tradeCount ?? t.total_count;
          const mdd = t.max_drawdown ?? t.maxDrawdown ?? t.max_retrace ?? t.maxRetrace;
          const name = t.user_name ?? t.userName ?? t.nickname ?? t.name ?? '';
          
          if (wr != null || tc != null) {
            let wrVal = parseFloat(wr);
            if (!isNaN(wrVal) && wrVal > 0 && wrVal <= 1) wrVal *= 100;
            
            traderData.set(leaderId, {
              win_rate: !isNaN(wrVal) ? Math.round(wrVal * 100) / 100 : null,
              trades_count: tc != null ? parseInt(tc) : null,
              max_drawdown: mdd != null ? -Math.abs(parseFloat(mdd) > 1 ? parseFloat(mdd) : parseFloat(mdd) * 100) : null
            });
            
            // Map various ID forms
            if (name) {
              idMapping.set(`cta_${name.toLowerCase()}`, leaderId);
              idMapping.set(name.toLowerCase(), leaderId);
            }
            idMapping.set(`cta_gateuser${leaderId}`, leaderId);
            idMapping.set(leaderId, leaderId);
          }
        }
        
        console.log(`  Intercepted ${list.length} traders, total collected: ${traderData.size}`);
      } catch {}
    }
  });

  // Navigate to Gate.io copy trading pages
  console.log('Navigating to Gate.io copy trading...');
  await page.goto('https://www.gate.io/copytrading', { waitUntil: 'networkidle', timeout: 30000 });
  await sleep(5000);

  // Try clicking through different time period tabs and scrolling
  const periods = ['7D', '30D', '90D'];
  for (const period of periods) {
    console.log(`\nScraping ${period} leaderboard...`);
    
    // Try clicking time period tabs
    const tabTexts = {
      '7D': ['Weekly', '7 Days', '7D', 'week'],
      '30D': ['Monthly', '30 Days', '30D', 'month'],
      '90D': ['Quarterly', '90 Days', '90D', 'quarter', '3 Months']
    };
    
    for (const text of tabTexts[period]) {
      try {
        const tab = page.getByText(text, { exact: false }).first();
        if (await tab.isVisible({ timeout: 2000 })) {
          await tab.click();
          await sleep(3000);
          break;
        }
      } catch {}
    }

    // Scroll down to load more data
    for (let scroll = 0; scroll < 20; scroll++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await sleep(1500);
      
      // Click "Load More" or "Show More" if present
      try {
        const more = page.getByText('Load More', { exact: false }).or(page.getByText('Show More', { exact: false })).or(page.getByText('View More', { exact: false }));
        if (await more.isVisible({ timeout: 1000 })) {
          await more.click();
          await sleep(2000);
        }
      } catch {}
    }
    
    console.log(`After ${period}: ${traderData.size} total traders collected`);
  }

  await browser.close();

  // Now match collected data to our needed traders
  console.log(`\n--- Matching ${traderData.size} collected traders to ${neededIds.size} needed ---`);
  
  let updated = 0;
  for (const row of nullRows) {
    const traderId = row.source_trader_id;
    
    // Try direct match
    let data = traderData.get(traderId);
    
    // Try via mapping
    if (!data) {
      const mapped = idMapping.get(traderId.toLowerCase());
      if (mapped) data = traderData.get(mapped);
    }
    
    // Try extracting ID from cta_gateuser format
    if (!data) {
      const match = traderId.match(/cta_gateuser(.+)/);
      if (match) data = traderData.get(match[1]);
    }
    
    if (!data || data.win_rate == null) continue;
    
    const updateObj = {};
    if (data.win_rate != null) updateObj.win_rate = data.win_rate;
    if (data.trades_count != null) updateObj.trades_count = data.trades_count;
    if (data.max_drawdown != null) updateObj.max_drawdown = data.max_drawdown;
    
    if (Object.keys(updateObj).length > 0) {
      const { error } = await supabase.from('leaderboard_ranks').update(updateObj).eq('id', row.id);
      if (!error) updated++;
    }
  }

  console.log(`\nGate.io done: updated ${updated}/${nullRows.length} rows`);
}

main().catch(console.error);
