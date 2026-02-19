/**
 * Gains enrichment via Playwright browser
 * Navigates to individual trader profile pages on gains.trade
 * Extracts win_rate from the page
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  // Get remaining null WR gains rows
  let nullRows = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id')
      .eq('source', 'gains').is('win_rate', null)
      .range(from, from + 999);
    if (!data?.length) break;
    nullRows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const byAddr = new Map();
  for (const r of nullRows) {
    if (!byAddr.has(r.source_trader_id)) byAddr.set(r.source_trader_id, []);
    byAddr.get(r.source_trader_id).push(r);
  }

  const addresses = [...byAddr.keys()];
  console.log(`Gains: ${nullRows.length} null rows, ${addresses.length} unique addresses`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  let updated = 0, noData = 0, deleted = 0, failed = 0;

  // Intercept API responses
  const statsMap = new Map();
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('personal-trading-history') || !url.includes('/stats')) return;
    try {
      const data = await res.json();
      // Extract address from URL
      const match = url.match(/personal-trading-history\/(0x[a-fA-F0-9]+)\/stats/);
      if (match && data) {
        statsMap.set(match[1].toLowerCase(), data);
      }
    } catch {}
  });

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    const rows = byAddr.get(addr);

    if (i % 10 === 0) console.log(`Progress: ${i}/${addresses.length} | updated=${updated} deleted=${deleted} noData=${noData} failed=${failed}`);

    try {
      // Navigate to trader's profile page on gains.trade
      statsMap.clear();
      await page.goto(`https://gains.trade/trading#trader=${addr}`, { 
        waitUntil: 'networkidle', 
        timeout: 20000 
      });
      await sleep(3000);

      // Check if we intercepted stats
      const stats = statsMap.get(addr.toLowerCase());
      
      if (stats && !stats.error) {
        const totalTrades = parseInt(stats.totalTrades || '0');
        const winRate = parseFloat(stats.winRate || '0');

        if (totalTrades === 0) {
          const ids = rows.map(r => r.id);
          await supabase.from('leaderboard_ranks').delete().in('id', ids);
          deleted += ids.length;
          continue;
        }

        const updateObj = {};
        if (!isNaN(winRate)) updateObj.win_rate = Math.round(winRate * 10000) / 100;
        if (totalTrades > 0) updateObj.trades_count = totalTrades;

        if (Object.keys(updateObj).length > 0) {
          const ids = rows.map(r => r.id);
          await supabase.from('leaderboard_ranks').update(updateObj).in('id', ids);
          updated += ids.length;
        }
      } else {
        noData++;
      }
    } catch (e) {
      failed++;
    }

    await sleep(2000);
  }

  await browser.close();
  console.log(`\nGains done: updated=${updated}, deleted=${deleted}, noData=${noData}, failed=${failed}`);
}

main().catch(console.error);
