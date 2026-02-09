import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://iknktzifjdyujdccyhsv.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE"
);

const PROXY = "http://127.0.0.1:7890";
const DELAY = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function proxyFetch(url: string): Promise<any> {
  const { ProxyAgent } = await import("undici");
  const agent = new ProxyAgent(PROXY);
  const res = await fetch(url, { dispatcher: agent as any, headers: { "User-Agent": "Mozilla/5.0" } });
  return res.json();
}

async function directFetch(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  return res.json();
}

async function fetchAll(source: string) {
  let all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("trader_sources")
      .select("source_trader_id")
      .eq("source", source)
      .is("avatar_url", null)
      .range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

// Concurrent update helper
async function updateBatch(rows: { source: string; id: string; avatar: string }[], concurrency = 20) {
  let i = 0;
  let done = 0;
  async function worker() {
    while (i < rows.length) {
      const idx = i++;
      const r = rows[idx];
      await supabase
        .from("trader_sources")
        .update({ avatar_url: r.avatar })
        .eq("source", r.source)
        .eq("source_trader_id", r.id);
      done++;
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, rows.length) }, () => worker());
  // Progress logger
  const interval = setInterval(() => {
    if (done > 0) console.log(`  DB update: ${done}/${rows.length}`);
  }, 5000);
  await Promise.all(workers);
  clearInterval(interval);
}

async function processHyperliquid() {
  const traders = await fetchAll("hyperliquid");
  console.log(`[hyperliquid] ${traders.length} traders without avatar`);
  if (!traders.length) return;
  
  const rows = traders.map((t: any) => ({
    source: "hyperliquid",
    id: t.source_trader_id,
    avatar: `https://effigy.im/a/${t.source_trader_id.toLowerCase()}.svg`,
  }));
  await updateBatch(rows);
  console.log(`[hyperliquid] Done: ${rows.length} updated`);
}

async function processBinance() {
  const traders = await fetchAll("binance_futures");
  console.log(`[binance_futures] ${traders.length} traders without avatar`);
  let updated = 0, failed = 0;

  for (let i = 0; i < traders.length; i++) {
    try {
      const data = await proxyFetch(
        `https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${traders[i].source_trader_id}`
      );
      const avatar = data?.data?.userPhotoUrl;
      if (avatar) {
        await supabase.from("trader_sources").update({ avatar_url: avatar })
          .eq("source", "binance_futures").eq("source_trader_id", traders[i].source_trader_id);
        updated++;
      }
    } catch (e: any) {
      failed++;
      if (failed <= 5) console.error(`  [binance] Error ${traders[i].source_trader_id}: ${e.message}`);
    }
    if ((i + 1) % 100 === 0) console.log(`  [binance] ${i + 1}/${traders.length}, ${updated} updated, ${failed} failed`);
    await sleep(DELAY);
  }
  console.log(`[binance_futures] Done: ${updated} updated, ${failed} failed`);
}

async function processBitget(source: "bitget_futures" | "bitget_spot") {
  const traders = await fetchAll(source);
  console.log(`[${source}] ${traders.length} traders without avatar`);
  let updated = 0, failed = 0;

  for (let i = 0; i < traders.length; i++) {
    try {
      const data = await directFetch(
        `https://www.bitget.com/v1/trigger/trace/public/traderDetail?traderUid=${traders[i].source_trader_id}`
      );
      const avatar = data?.data?.avatar || data?.data?.traderAvatar;
      if (avatar) {
        await supabase.from("trader_sources").update({ avatar_url: avatar })
          .eq("source", source).eq("source_trader_id", traders[i].source_trader_id);
        updated++;
      }
    } catch (e: any) {
      failed++;
      if (failed <= 5) console.error(`  [${source}] Error: ${e.message}`);
    }
    if ((i + 1) % 100 === 0) console.log(`  [${source}] ${i + 1}/${traders.length}, ${updated} updated, ${failed} failed`);
    await sleep(DELAY);
  }
  console.log(`[${source}] Done: ${updated} updated, ${failed} failed`);
}

async function main() {
  console.log("=== Avatar Backfill Script ===\n");
  await processHyperliquid();
  await processBitget("bitget_futures");
  await processBitget("bitget_spot");
  await processBinance();
  console.log("\n=== Done ===");
}

main().catch(console.error);
