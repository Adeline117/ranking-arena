import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://iknktzifjdyujdccyhsv.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE"
);

const PROXY = "http://127.0.0.1:7890";
const DELAY = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchAllNull(source: string) {
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

async function updateBatch(rows: { source: string; id: string; avatar: string }[], concurrency = 20) {
  let i = 0;
  let done = 0;
  async function worker() {
    while (i < rows.length) {
      const idx = i++;
      const r = rows[idx];
      await supabase.from("trader_sources").update({ avatar_url: r.avatar })
        .eq("source", r.source).eq("source_trader_id", r.id);
      done++;
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, rows.length) }, () => worker());
  const interval = setInterval(() => console.log(`  DB update: ${done}/${rows.length}`), 5000);
  await Promise.all(workers);
  clearInterval(interval);
  console.log(`  DB update: ${done}/${rows.length} complete`);
}

// Bitget: set default avatar for those without one (all Bitget avatars are the same default anyway)
async function processBitget() {
  const defaultAvatar = "https://img.bgstatic.com/multiLang/web/cba5c7064793fae75b583023f22a6bca.png";
  for (const source of ["bitget_futures", "bitget_spot"] as const) {
    const traders = await fetchAllNull(source);
    console.log(`[${source}] ${traders.length} traders without avatar — setting default`);
    if (!traders.length) continue;
    const rows = traders.map((t: any) => ({ source, id: t.source_trader_id, avatar: defaultAvatar }));
    await updateBatch(rows);
    console.log(`[${source}] Done`);
  }
}

// Binance: fetch actual avatars via proxy
async function processBinance() {
  const { ProxyAgent } = await import("undici");
  const agent = new ProxyAgent(PROXY);

  const traders = await fetchAllNull("binance_futures");
  console.log(`[binance_futures] ${traders.length} traders without avatar`);
  let updated = 0, failed = 0, noAvatar = 0;

  for (let i = 0; i < traders.length; i++) {
    const id = traders[i].source_trader_id;
    try {
      const res = await fetch(
        `https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${id}`,
        { dispatcher: agent, signal: AbortSignal.timeout(10000), headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" } } as RequestInit
      );
      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { noAvatar++; continue; }
      const avatar = data?.data?.avatarUrl;
      const nickname = data?.data?.nickname;
      if (avatar) {
        const updateObj: any = { avatar_url: avatar };
        if (nickname) updateObj.handle = nickname;
        await supabase.from("trader_sources").update(updateObj)
          .eq("source", "binance_futures").eq("source_trader_id", id);
        updated++;
      } else {
        noAvatar++;
        if (noAvatar <= 3) console.log(`  [binance] No avatar for ${id}: ${JSON.stringify(data).slice(0, 200)}`);
      }
    } catch (e: any) {
      failed++;
      if (failed <= 5) console.error(`  [binance] Error ${id}: ${e.message}`);
    }
    if ((i + 1) % 100 === 0) console.log(`  [binance] ${i + 1}/${traders.length}, ${updated} updated, ${noAvatar} no avatar, ${failed} failed`);
    await sleep(DELAY);
  }
  console.log(`[binance_futures] Done: ${updated} updated, ${noAvatar} no avatar, ${failed} failed`);
}

async function main() {
  console.log("=== Avatar Backfill Script ===\n");
  await processBitget();
  await processBinance();
  console.log("\n=== Done ===");
}

main().catch(console.error);
