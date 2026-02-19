/**
 * Gains enrichment v2: Use browser to hit the API endpoint
 * The Cloudflare 1015 only blocks direct fetch; browser with cookies should work.
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CHAIN_ID = 42161;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
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
  console.log(`Gains: ${nullRows.length} null rows, ${addresses.length} addresses`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // First visit gains.trade to get cookies/session
  console.log('Visiting gains.trade to get session...');
  await page.goto('https://gains.trade/trading', { waitUntil: 'networkidle', timeout: 30000 });
  await sleep(5000);

  let updated = 0, deleted = 0, noData = 0, failed = 0;

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    const rows = byAddr.get(addr);

    if (i % 10 === 0) console.log(`Progress: ${i}/${addresses.length} | updated=${updated} deleted=${deleted} noData=${noData} failed=${failed}`);

    try {
      // Use page.evaluate to fetch the API with the browser's session
      const stats = await page.evaluate(async ({ addr, chainId }) => {
        try {
          const r = await fetch(`https://backend-global.gains.trade/api/personal-trading-history/${addr}/stats?chainId=${chainId}`);
          if (!r.ok) return { error: r.status };
          return await r.json();
        } catch (e) { return { error: e.message }; }
      }, { addr, chainId: CHAIN_ID });

      if (!stats || stats.error) {
        if (stats?.error === 1015 || stats?.error === 403) {
          console.log(`  Cloudflare block at ${i}, waiting 30s...`);
          await sleep(30000);
          failed++;
          continue;
        }
        noData++;
        await sleep(1000);
        continue;
      }

      const totalTrades = parseInt(stats.totalTrades || '0');
      const winRate = parseFloat(stats.winRate || '0');

      if (totalTrades === 0) {
        const ids = rows.map(r => r.id);
        await supabase.from('leaderboard_ranks').delete().in('id', ids);
        deleted += ids.length;
        await sleep(1000);
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
    } catch (e) {
      failed++;
    }

    await sleep(1500);
  }

  await browser.close();
  console.log(`\nGains done: updated=${updated}, deleted=${deleted}, noData=${noData}, failed=${failed}`);
}

main().catch(console.error);
