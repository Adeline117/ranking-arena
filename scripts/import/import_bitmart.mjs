/**
 * BitMart Copy Trading import (Playwright DOM extraction)
 * 
 * Strategy: Load /ai/copy-trading, click "Masters" tab, scroll to load all,
 * extract trader links, then scrape each detail page for full metrics.
 * 
 * Usage: node scripts/import/import_bitmart.mjs [7D|30D|90D|ALL]
 */
import { chromium } from 'playwright';
import { getSupabaseClient, calculateArenaScore, sleep, getTargetPeriods } from '../lib/shared.mjs';

const supabase = getSupabaseClient();
const SOURCE = 'bitmart';

async function scrapeDetailPage(page, uuid, name) {
  try {
    await page.goto(`https://www.bitmart.com/ai/copy-trading/master-detail/${uuid}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await sleep(3000);
    
    return await page.evaluate(() => {
      const text = document.body.innerText;
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      
      const getValueAfterLabel = (label) => {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(label) && i + 1 < lines.length) {
            const val = lines[i + 1].replace(/[,$%+]/g, '').trim();
            const num = parseFloat(val);
            if (!isNaN(num)) return num;
          }
        }
        return null;
      };
      
      // Also try inline patterns
      const matchPct = (pattern) => {
        const m = text.match(pattern);
        return m ? parseFloat(m[1]) : null;
      };
      
      const roi = matchPct(/Total ROI[:\s]*([+-]?\d+\.?\d*)%/i) 
        || matchPct(/ROI[:\s]*([+-]?\d+\.?\d*)%/i)
        || getValueAfterLabel('Total ROI');
      const wr = matchPct(/Win Rate[:\s]*(\d+\.?\d*)%/i) 
        || matchPct(/P\/L Ratio[:\s]*(\d+\.?\d*)%/i)
        || getValueAfterLabel('Win Rate');
      const mdd = matchPct(/Max(?:imum)? Drawdown[:\s]*(-?\d+\.?\d*)%/i)
        || getValueAfterLabel('Max Drawdown');
      const pnl = getValueAfterLabel('Total PnL') || getValueAfterLabel('PnL');
      const aum = getValueAfterLabel('AUM');
      const copiers = getValueAfterLabel('Copiers') || getValueAfterLabel('Followers');
      
      // Avatar
      const img = document.querySelector('img[src*="cloudfront"], img[src*="avatar"]');
      const avatar = img?.src || null;
      
      return { roi, wr, mdd: mdd != null ? Math.abs(mdd) : null, pnl, aum, copiers, avatar };
    });
  } catch (e) {
    console.log(`    ⚠️ Failed ${name}: ${e.message.slice(0, 50)}`);
    return null;
  }
}

async function main() {
  const periods = getTargetPeriods(process.argv[2] ? [process.argv[2]] : ['30D']);
  console.log(`BitMart Copy Trading import | Periods: ${periods.join(', ')}`);
  
  const browser = await chromium.launch({ headless: false, args: ['--disable-gpu'] });
  
  try {
    const page = await browser.newPage();
    
    console.log('  Loading BitMart copy trading...');
    await page.goto('https://www.bitmart.com/ai/copy-trading', {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    await sleep(10000);
    
    // Click Masters tab
    try {
      await page.getByText('Masters', { exact: true }).click();
      console.log('  Clicked Masters tab');
      await sleep(5000);
    } catch {}
    
    // Scroll to load all masters
    console.log('  Scrolling to load all traders...');
    let prevCount = 0;
    let stableRounds = 0;
    for (let i = 0; i < 100; i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await sleep(1500);
      const count = await page.evaluate(() => document.querySelectorAll('a[href*="master-detail"]').length);
      if (count === prevCount) { stableRounds++; if (stableRounds >= 5) break; }
      else { stableRounds = 0; prevCount = count; }
    }
    
    // Extract trader links
    const traderLinks = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="master-detail"]');
      const seen = new Set();
      const results = [];
      links.forEach(link => {
        const name = (link.innerText || '').trim();
        const href = link.getAttribute('href') || '';
        const uuid = href.split('/').pop();
        if (!uuid || seen.has(uuid) || !name || name === 'Copy' || name.length > 50) return;
        seen.add(uuid);
        results.push({ name, uuid });
      });
      return results;
    });
    
    console.log(`  Found ${traderLinks.length} unique traders`);
    
    if (traderLinks.length === 0) {
      console.log('  ERROR: No traders found');
      await browser.close();
      return;
    }
    
    // Scrape each detail page
    console.log(`  Scraping ${traderLinks.length} detail pages...`);
    const detailPage = await browser.newPage();
    const traders = [];
    
    for (let i = 0; i < traderLinks.length; i++) {
      const { name, uuid } = traderLinks[i];
      const detail = await scrapeDetailPage(detailPage, uuid, name);
      
      if (detail) {
        traders.push({
          uuid,
          name,
          roi: detail.roi,
          pnl: detail.pnl,
          wr: detail.wr,
          mdd: detail.mdd,
          aum: detail.aum,
          copiers: detail.copiers ? Math.round(detail.copiers) : 0,
          avatar: detail.avatar,
        });
      }
      
      if ((i + 1) % 10 === 0) console.log(`    ${i + 1}/${traderLinks.length} done`);
    }
    
    await detailPage.close();
    console.log(`\n  Successfully scraped ${traders.length} traders`);
    
    // TOP 5
    traders.sort((a, b) => (b.roi || 0) - (a.roi || 0));
    console.log('\n  TOP 5:');
    traders.slice(0, 5).forEach((t, i) => {
      console.log(`    ${i+1}. ${t.name} | ROI: ${t.roi}% | WR: ${t.wr}% | MDD: ${t.mdd}% | AUM: ${t.aum}`);
    });
    
    // Save to DB
    const capturedAt = new Date().toISOString();
    
    for (const period of periods) {
      // Upsert trader_sources
      const sources = traders.map(t => ({
        source: SOURCE,
        source_trader_id: t.uuid,
        handle: t.name,
        avatar_url: t.avatar,
        is_active: true,
        source_kind: 'exchange',
        market_type: 'futures',
      }));
      
      for (let i = 0; i < sources.length; i += 50) {
        const { error } = await supabase.from('trader_sources').upsert(
          sources.slice(i, i + 50), 
          { onConflict: 'source,source_trader_id' }
        );
        if (error) console.log(`  ⚠️ source upsert error: ${error.message}`);
      }
      
      // Upsert trader_snapshots
      const snapshots = traders.map((t, idx) => {
        const scores = calculateArenaScore(t.roi, t.pnl || 0, t.mdd, t.wr, period);
        return {
          source: SOURCE,
          source_trader_id: t.uuid,
          season_id: period,
          rank: idx + 1,
          roi: t.roi,
          pnl: t.pnl || null,
          win_rate: t.wr,
          max_drawdown: t.mdd,
          followers: t.copiers || 0,
          aum: t.aum,
          arena_score: typeof scores === 'object' ? scores.totalScore : scores,
          captured_at: capturedAt,
        };
      });
      
      let saved = 0;
      for (let i = 0; i < snapshots.length; i += 50) {
        const batch = snapshots.slice(i, i + 50);
        const { error } = await supabase.from('trader_snapshots').upsert(
          batch, 
          { onConflict: 'source,source_trader_id,season_id' }
        );
        if (!error) saved += batch.length;
        else console.log(`  ⚠️ snapshot upsert error: ${error.message}`);
      }
      
      console.log(`  ${period}: saved ${saved} traders`);
    }
    
    console.log('\n✅ BitMart complete');
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
