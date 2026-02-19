/**
 * Gate.io enrichment: Navigate to individual trader detail pages via Playwright
 * Extract win_rate from the copy trading profile page
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
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

  const byTrader = new Map();
  for (const r of nullRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, []);
    byTrader.get(r.source_trader_id).push(r);
  }
  const traders = [...byTrader.keys()];
  console.log(`Gate.io: ${nullRows.length} null rows, ${traders.length} unique traders`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });

  let updated = 0, failed = 0, noData = 0;

  // Gate.io copy trading detail page URL pattern
  // trader IDs are like "cta_gateuser081d1c52" - need to extract the ID part
  for (let i = 0; i < Math.min(traders.length, 50); i++) { // Start with 50 to test
    const traderId = traders[i];
    const rows = byTrader.get(traderId);
    
    if (i % 10 === 0) console.log(`Progress: ${i}/${traders.length} | updated=${updated} failed=${failed} noData=${noData}`);

    // Extract numeric ID or handle from the source_trader_id
    // Format: cta_gateuser081d1c52 -> try navigating to the Gate.io detail page
    const page = await context.newPage();
    
    // Intercept API responses for this trader
    let traderStats = null;
    page.on('response', async (res) => {
      const url = res.url();
      if (url.includes('/copy/leader/detail') || url.includes('/copytrade/') || url.includes('/copy_trading/')) {
        try {
          const data = await res.json();
          if (data?.code === 0 && data?.data) {
            const d = data.data;
            traderStats = {
              win_rate: d.win_rate ?? d.winRate ?? d.win_ratio,
              trades_count: d.order_count ?? d.trade_count ?? d.total_trades,
              max_drawdown: d.max_drawdown ?? d.max_retrace
            };
          }
        } catch {}
      }
    });

    try {
      // Try the Gate.io copy trading detail page
      const cleanId = traderId.replace('cta_', '');
      await page.goto(`https://www.gate.io/copytrade/detail/${cleanId}`, {
        waitUntil: 'networkidle',
        timeout: 15000
      });
      await sleep(3000);

      if (traderStats) {
        const updateObj = {};
        if (traderStats.win_rate != null) {
          let wr = parseFloat(traderStats.win_rate);
          if (wr > 0 && wr <= 1) wr *= 100;
          if (!isNaN(wr)) updateObj.win_rate = Math.round(wr * 100) / 100;
        }
        if (traderStats.trades_count != null) updateObj.trades_count = parseInt(traderStats.trades_count);
        if (traderStats.max_drawdown != null) {
          let mdd = Math.abs(parseFloat(traderStats.max_drawdown));
          if (mdd > 0 && mdd <= 1) mdd *= 100;
          updateObj.max_drawdown = -Math.round(mdd * 100) / 100;
        }

        if (Object.keys(updateObj).length > 0) {
          const ids = rows.map(r => r.id);
          await supabase.from('leaderboard_ranks').update(updateObj).in('id', ids);
          updated += ids.length;
        } else {
          noData++;
        }
      } else {
        noData++;
      }
    } catch (e) {
      failed++;
    }

    await page.close();
    await sleep(2000);
  }

  await browser.close();
  console.log(`\nGate.io done: updated=${updated}, failed=${failed}, noData=${noData}`);
}

main().catch(console.error);
