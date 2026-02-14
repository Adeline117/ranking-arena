/**
 * BloFin Copy Trading scraper (Puppeteer Stealth)
 * Bypasses Cloudflare using puppeteer-extra-plugin-stealth
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from "../lib/shared.mjs";

const supabase = getSupabaseClient();
const SOURCE = "blofin";
const PERIOD_MAP = { "7D": 1, "30D": 2, "90D": 3 };

function parseTrader(t) {
  let roi = parseFloat(String(t.roi || 0));
  let mdd = t.mdd != null ? Math.abs(parseFloat(String(t.mdd))) : null;
  let wr = t.winRate != null ? parseFloat(String(t.winRate)) : null;
  if (wr != null && wr > 0 && wr <= 1) wr *= 100;
  return {
    id: String(t.uid || t.uniqueName || ""),
    name: t.nick_name || t.nickName || `Trader_${String(t.uid || "").slice(0, 8)}`,
    avatar: t.profile || t.avatar || null,
    roi, pnl: parseFloat(String(t.pnl || 0)),
    mdd, winRate: wr,
    followers: parseInt(String(t.followers || t.copiers || 0)),
    aum: parseFloat(String(t.aum || 0)),
  };
}

async function scrapeTraders() {
  console.log("BloFin stealth: launching browser...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  const tradersByPeriod = { "7D": new Map(), "30D": new Map(), "90D": new Map() };

  try {
    console.log("  Navigating to BloFin...");
    await page.goto("https://blofin.com/copy-trade?tab=leaderboard&module=futures", {
      waitUntil: "networkidle2", timeout: 60000,
    });
    
    const title = await page.title();
    console.log(`  Title: ${title}`);
    
    if (title.includes("moment") || title.includes("Check")) {
      console.log("  CF challenge, waiting 20s...");
      await sleep(20000);
      const t2 = await page.title();
      console.log(`  Title after wait: ${t2}`);
      if (t2.includes("moment")) {
        console.log("  Still blocked by CF, aborting");
        await browser.close();
        return tradersByPeriod;
      }
    }

    // Wait for page to fully load
    await sleep(5000);

    // Use in-page fetch to call the rank API
    for (const [period, rangeTime] of Object.entries(PERIOD_MAP)) {
      const result = await page.evaluate(async () => {
        try {
          const r = await fetch("/uapi/v1/copy/trader/rank", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ nick_name: "", limit: 100 }),
          });
          return await r.json();
        } catch (e) { return { error: e.message }; }
      });

      if (result?.code === 200 && result.data) {
        const map = tradersByPeriod[period];
        for (const [key, list] of Object.entries(result.data)) {
          if (!Array.isArray(list)) continue;
          for (const t of list) {
            const trader = parseTrader(t);
            if (trader.id && !map.has(trader.id)) map.set(trader.id, trader);
          }
        }
        console.log(`  ${period} rank: ${map.size} unique`);
      } else {
        console.log(`  ${period} rank: failed - ${result?.error || result?.msg || "unknown"}`);
      }
      await sleep(500);
    }

    // Try list endpoint with pagination
    for (const rangeTime of [1, 2, 3]) {
      const period = rangeTime === 1 ? "7D" : rangeTime === 3 ? "90D" : "30D";
      const map = tradersByPeriod[period];
      
      for (let pg = 1; pg <= 5; pg++) {
        const result = await page.evaluate(async ({ rangeTime, pg }) => {
          try {
            const r = await fetch("/uapi/v1/copy/trader/list?range_time=" + rangeTime + "&page=" + pg + "&pageSize=50&limit=50");
            if (r.ok) return await r.json();
            // try POST
            const r2 = await fetch("/uapi/v1/copy/trader/list", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ range_time: rangeTime, page: pg, pageSize: 50 }),
            });
            return await r2.json();
          } catch { return null; }
        }, { rangeTime, pg });

        if (result?.data) {
          const list = Array.isArray(result.data) ? result.data :
                       Array.isArray(result.data?.list) ? result.data.list :
                       Array.isArray(result.data?.rows) ? result.data.rows : [];
          let added = 0;
          for (const t of list) {
            const trader = parseTrader(t);
            if (trader.id && !map.has(trader.id)) { map.set(trader.id, trader); added++; }
          }
          if (added) console.log(`  list ${period} p${pg}: +${added}`);
          if (list.length < 20) break;
        } else break;
        await sleep(300);
      }
    }

  } catch (e) {
    console.error(`  Error: ${e.message}`);
  } finally {
    await browser.close();
  }

  return tradersByPeriod;
}

async function saveTraders(traders, period) {
  if (!traders.length) { console.log(`  ⚠ ${period}: no data`); return 0; }
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0));
  const now = new Date().toISOString();
  console.log(`\n💾 Saving ${traders.length} ${period} records...`);

  for (let i = 0; i < traders.length; i += 30) {
    await supabase.from("trader_sources").upsert(
      traders.slice(i, i + 30).map(t => ({
        source: SOURCE, source_trader_id: t.id, handle: t.name,
        avatar_url: t.avatar, market_type: "futures", is_active: true,
      })),
      { onConflict: "source,source_trader_id" }
    );
  }

  let saved = 0;
  for (let i = 0; i < traders.length; i += 30) {
    const batch = traders.slice(i, i + 30).map((t, j) => {
      const scores = calculateArenaScore(t.roi, t.pnl, t.mdd, t.winRate, period);
      return {
        source: SOURCE, source_trader_id: t.id, season_id: period,
        rank: i + j + 1, roi: t.roi, pnl: t.pnl,
        max_drawdown: t.mdd, win_rate: t.winRate,
        followers: t.followers, arena_score: scores.totalScore,
        captured_at: now,
      };
    });
    const { error } = await supabase.from("trader_snapshots").upsert(batch, { onConflict: "source,source_trader_id,season_id" });
    if (!error) saved += batch.length;
    else console.log(`  ⚠ upsert error: ${error.message}`);
  }
  console.log(`  ✅ Saved: ${saved}/${traders.length}`);
  return saved;
}

async function main() {
  const periods = getTargetPeriods(["7D", "30D", "90D"]);
  console.log(`BloFin stealth scraper | Periods: ${periods.join(", ")}`);

  const tradersByPeriod = await scrapeTraders();

  let total = 0;
  for (const p of periods) {
    const map = tradersByPeriod[p];
    let traders = map ? [...map.values()] : [];
    if (!traders.length) {
      for (const fb of ["30D", "7D", "90D"]) {
        if (tradersByPeriod[fb]?.size > 0) {
          traders = [...tradersByPeriod[fb].values()];
          console.log(`  ${p}: using ${fb} fallback (${traders.length})`);
          break;
        }
      }
    }
    total += await saveTraders(traders, p);
  }

  console.log(`\n✅ BloFin done: ${total} records saved`);
}

main().catch(e => { console.error(e); process.exit(1); });
