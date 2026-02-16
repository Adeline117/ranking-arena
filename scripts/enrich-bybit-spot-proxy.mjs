#!/usr/bin/env node
/**
 * Bybit Spot enrichment via Puppeteer through SOCKS proxy (VPS tunnel)
 * Run: ssh -D 1080 -f -N root@45.76.152.169
 * Then: node scripts/enrich-bybit-spot-proxy.mjs
 */
import 'dotenv/config';
import pg from 'pg';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('=== Bybit Spot enrichment (local Puppeteer + SOCKS proxy) ===');
  const client = await pool.connect();

  const { rows: needed } = await client.query(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source = 'bybit_spot' 
      AND (trades_count IS NULL OR max_drawdown IS NULL)
  `);
  const needSet = new Set(needed.map(r => r.source_trader_id));
  console.log(`Traders needing enrichment: ${needSet.size}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--proxy-server=socks5://127.0.0.1:1080'
    ]
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  // Navigate to api2.bybit.com instead so fetch() is same-origin
  console.log('Visiting api2.bybit.com through proxy...');
  try {
    // First visit bybit.com to get cookies
    await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000);
    // Get cookies and set them for api2 domain
    const cookies = await page.cookies();
    const api2Cookies = cookies.map(c => ({...c, domain: '.bybit.com'}));
    await page.setCookie(...api2Cookies);
    console.log('Cookies set');
  } catch (e) {
    console.log('Warning:', e.message?.slice(0, 100));
  }

  const uidToMark = new Map();
  let updated = 0;

  // Use CDP to make requests directly (avoids CORS)
  const cdp = await page.createCDPSession();

  async function cdpFetch(url) {
    try {
      const cookies = await page.cookies('https://api2.bybit.com');
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const result = await page.evaluate(async (fetchUrl, ck) => {
        try {
          const r = await fetch(fetchUrl, { 
            headers: { 'Cookie': ck },
            credentials: 'include'
          });
          if (!r.ok) return { error: r.status };
          return await r.json();
        } catch (e) { return { error: e.message }; }
      }, url, cookieStr);
      return result;
    } catch (e) {
      return { error: e.message };
    }
  }

  // Paginate listing API
  for (const duration of ['DATA_DURATION_NINETY_DAY', 'DATA_DURATION_THIRTY_DAY', 'DATA_DURATION_SEVEN_DAY']) {
    console.log(`\n📡 Listing ${duration}...`);
    for (let pageNo = 1; pageNo <= 100; pageNo++) {
      const result = await Promise.race([
        cdpFetch(`https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${pageNo}&pageSize=50&dataDuration=${duration}&sortField=LEADER_SORT_FIELD_SORT_ROI`),
        sleep(20000).then(() => ({ error: 'timeout' }))
      ]);

      if (!result || result.error || result.retCode !== 0) {
        console.log(`  Page ${pageNo}: error:`, result?.error || result?.retMsg);
        if (result?.error === 'timeout' || result?.error === 403) break;
        break;
      }

      const items = result.result?.leaderDetails || [];
      if (!items.length) { console.log(`  Page ${pageNo}: empty`); break; }

      let pageMatches = 0;
      for (const item of items) {
        const uid = String(item.leaderUserId || '');
        if (needSet.has(uid) && item.leaderMark) {
          uidToMark.set(uid, item.leaderMark);
          pageMatches++;
        }
      }

      if (pageNo % 10 === 0 || pageMatches > 0)
        console.log(`  Page ${pageNo}: ${items.length} items, matches=${pageMatches}, total mapped=${uidToMark.size}`);
      await sleep(500);
    }
  }

  console.log(`\nMapped ${uidToMark.size} traders. Fetching income data...`);

  const entries = [...uidToMark.entries()];
  for (let i = 0; i < entries.length; i++) {
    const [uid, mark] = entries[i];

    if (i > 0 && i % 200 === 0) {
      try {
        await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
      } catch {}
    }

    const incomeData = await Promise.race([
      page.evaluate(async (lm) => {
        try {
          const r = await fetch(`https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${lm}`);
          if (!r.ok) return null;
          return await r.json();
        } catch { return null; }
      }, mark),
      sleep(10000).then(() => null)
    ]);

    if (!incomeData || incomeData.retCode !== 0) { await sleep(200); continue; }

    const inc = incomeData.result;
    let tc = null, mdd = null;
    for (const pfx of ['ninetyDay', 'thirtyDay', 'sevenDay']) {
      const wc = parseInt(inc[pfx + 'WinCount'] || '0');
      const lc = parseInt(inc[pfx + 'LossCount'] || '0');
      if (wc + lc > 0 && tc == null) tc = wc + lc;
      const dd = parseInt(inc[pfx + 'DrawDownE4'] || '0');
      if (dd > 0 && mdd == null) mdd = dd / 100;
    }
    if (tc == null) {
      const cum = parseInt(inc.cumTradeCount || '0');
      if (cum > 0) tc = cum;
    }

    if (tc == null && mdd == null) { await sleep(200); continue; }

    const sets = [];
    const vals = [];
    let idx = 1;
    if (tc != null) { sets.push(`trades_count = $${idx}`); vals.push(tc); idx++; }
    if (mdd != null) { sets.push(`max_drawdown = $${idx}`); vals.push(mdd); idx++; }
    vals.push(uid);

    const r1 = await client.query(
      `UPDATE trader_snapshots SET ${sets.join(', ')} 
       WHERE source = 'bybit_spot' AND source_trader_id = $${idx}
         AND (trades_count IS NULL OR max_drawdown IS NULL)`,
      vals
    );
    const r2 = await client.query(
      `UPDATE leaderboard_ranks SET ${sets.join(', ')} 
       WHERE source = 'bybit_spot' AND source_trader_id = $${idx}
         AND (trades_count IS NULL OR max_drawdown IS NULL)`,
      vals
    );
    updated += r1.rowCount + r2.rowCount;

    if ((i + 1) % 50 === 0) console.log(`  Income ${i+1}/${entries.length} | updated=${updated}`);
    await sleep(400);
  }

  await browser.close();

  const verify = await client.query(`
    SELECT 
      COUNT(*) FILTER (WHERE trades_count IS NULL) as tc_null,
      COUNT(*) FILTER (WHERE max_drawdown IS NULL) as mdd_null,
      COUNT(*) as total
    FROM trader_snapshots WHERE source = 'bybit_spot'
  `);
  console.log('\nDone! Updated:', updated);
  console.log('Remaining gaps:', verify.rows[0]);

  client.release();
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
