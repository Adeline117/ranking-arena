import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://iknktzifjdyujdccyhsv.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE"
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchMissing(source: string): Promise<string[]> {
  let all: string[] = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from("trader_sources")
      .select("source_trader_id")
      .eq("source", source)
      .is("avatar_url", null)
      .range(from, from + 999);
    if (!data?.length) break;
    all = all.concat(data.map((d) => d.source_trader_id));
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function updateAvatar(source: string, id: string, url: string) {
  await supabase
    .from("trader_sources")
    .update({ avatar_url: url })
    .eq("source", source)
    .eq("source_trader_id", id);
}

async function fetchWithTimeout(url: string, ms = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ============ Hyperliquid: Use Ethereum identicon service ============
async function backfillHyperliquid() {
  const ids = await fetchMissing("hyperliquid");
  console.log(`[hyperliquid] ${ids.length} missing avatars`);
  let updated = 0;
  // Batch update — these are deterministic URLs, no API calls needed
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    for (const id of batch) {
      const url = `https://effigy.im/a/${id}.svg`;
      await updateAvatar("hyperliquid", id, url);
      updated++;
    }
    console.log(`[hyperliquid] ${updated}/${ids.length}`);
  }
  return updated;
}

// ============ Bitget Futures ============
async function backfillBitgetFutures() {
  const ids = await fetchMissing("bitget_futures");
  console.log(`[bitget_futures] ${ids.length} missing avatars`);
  let updated = 0, failed = 0;
  for (const id of ids) {
    try {
      const res = await fetchWithTimeout(
        `https://www.bitget.com/v1/trigger/trace/public/traderDetail?traderUid=${id}`
      );
      const json = await res.json();
      const avatar = json?.data?.avatar || json?.data?.portraitLink;
      if (avatar) {
        await updateAvatar("bitget_futures", id, avatar);
        updated++;
      }
    } catch { failed++; }
    if ((updated + failed) % 50 === 0) console.log(`[bitget_futures] ${updated} updated, ${failed} failed / ${ids.length}`);
    await sleep(300);
  }
  return updated;
}

// ============ Bitget Spot ============
async function backfillBitgetSpot() {
  const ids = await fetchMissing("bitget_spot");
  console.log(`[bitget_spot] ${ids.length} missing avatars`);
  let updated = 0, failed = 0;
  for (const id of ids) {
    try {
      const res = await fetchWithTimeout(
        `https://www.bitget.com/v1/trigger/trace/public/traderDetail?traderUid=${id}`
      );
      const json = await res.json();
      const avatar = json?.data?.avatar || json?.data?.portraitLink;
      if (avatar) {
        await updateAvatar("bitget_spot", id, avatar);
        updated++;
      }
    } catch { failed++; }
    if ((updated + failed) % 50 === 0) console.log(`[bitget_spot] ${updated} updated, ${failed} failed / ${ids.length}`);
    await sleep(300);
  }
  return updated;
}

// ============ On-chain DEX: identicons ============
async function backfillOnchain(source: string) {
  const ids = await fetchMissing(source);
  console.log(`[${source}] ${ids.length} missing avatars`);
  let updated = 0;
  for (const id of ids) {
    if (id.startsWith("0x")) {
      await updateAvatar(source, id, `https://effigy.im/a/${id}.svg`);
      updated++;
    }
  }
  console.log(`[${source}] ${updated} updated`);
  return updated;
}

async function main() {
  console.log("=== Avatar Backfill v2 ===");

  // 1. Hyperliquid — instant (identicons)
  const hl = await backfillHyperliquid();
  console.log(`Hyperliquid: +${hl}`);

  // 2. On-chain DEXes — instant (identicons)
  for (const src of ["gmx", "dydx", "gains", "drift", "jupiter_perps", "kwenta", "synthetix", "vertex", "mux"]) {
    const n = await backfillOnchain(src);
    if (n > 0) console.log(`${src}: +${n}`);
  }

  // 3. Bitget — API calls
  const bf = await backfillBitgetFutures();
  console.log(`Bitget Futures: +${bf}`);

  const bs = await backfillBitgetSpot();
  console.log(`Bitget Spot: +${bs}`);

  console.log("=== Done ===");
}

main().catch(console.error);
