/**
 * Backfill missing avatars for all supported CEX sources using their detail APIs.
 * NO generated avatars (DiceBear/identicon). Only real avatars from platform APIs.
 */
import pg from 'pg';
const { Client } = pg;

const DB = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', ...headers },
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---- Source-specific detail fetchers ----

async function fetchBinanceFuturesAvatar(id: string): Promise<string | null> {
  try {
    const json = await fetchJSON(
      `https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${id}`,
      { Origin: 'https://www.binance.com', Referer: 'https://www.binance.com/en/copy-trading' }
    ) as { data?: { avatarUrl?: string } };
    return json?.data?.avatarUrl || null;
  } catch { return null; }
}

async function fetchBinanceSpotAvatar(id: string): Promise<string | null> {
  // Same API endpoint works for spot too
  return fetchBinanceFuturesAvatar(id);
}

async function fetchMexcAvatar(id: string): Promise<string | null> {
  try {
    const json = await fetchJSON(
      `https://www.mexc.com/api/platform/copy-trade/trader/detail?traderId=${id}`,
      { Origin: 'https://www.mexc.com', Referer: `https://www.mexc.com/copy-trading/trader/${id}` }
    ) as { data?: { avatar?: string } };
    return json?.data?.avatar || null;
  } catch { return null; }
}

async function fetchBybitAvatar(id: string): Promise<string | null> {
  try {
    const json = await fetchJSON(
      `https://api2.bybit.com/fapi/beehive/public/v1/common/leader/detail?leaderMark=${id}`,
      { Origin: 'https://www.bybit.com', Referer: `https://www.bybit.com/copyTrading/trade-center/detail?leaderMark=${id}` }
    ) as { result?: { avatar?: string } };
    return json?.result?.avatar || null;
  } catch { return null; }
}

async function fetchKucoinAvatar(id: string): Promise<string | null> {
  try {
    const json = await fetchJSON(
      `https://www.kucoin.com/_api/copy-trade/leader/detail?leaderUserId=${id}`,
      { Origin: 'https://www.kucoin.com', Referer: `https://www.kucoin.com/copy-trading/leader/${id}` }
    ) as { data?: { avatar?: string; portraitUrl?: string } };
    return json?.data?.avatar || json?.data?.portraitUrl || null;
  } catch { return null; }
}

async function fetchCoinexAvatar(id: string): Promise<string | null> {
  try {
    const json = await fetchJSON(
      `https://www.coinex.com/res/copy-trade/leader/detail?leader_id=${id}`,
      { Origin: 'https://www.coinex.com', Referer: `https://www.coinex.com/copy-trading` }
    ) as { data?: { avatar_url?: string; avatar?: string } };
    return json?.data?.avatar_url || json?.data?.avatar || null;
  } catch { return null; }
}

async function fetchBitgetAvatar(id: string): Promise<string | null> {
  try {
    const json = await fetchJSON(
      `https://www.bitget.com/v1/trigger/trace/public/traderDetail?traderUid=${id}`,
      {}
    ) as { data?: { avatar?: string; portraitLink?: string } };
    return json?.data?.avatar || json?.data?.portraitLink || null;
  } catch { return null; }
}

async function fetchWeexAvatar(id: string): Promise<string | null> {
  try {
    const json = await fetchJSON(
      `https://www.weex.com/api/v1/copy-trade/trader/detail?traderId=${id}`,
      { Origin: 'https://www.weex.com', Referer: 'https://www.weex.com/copy-trading' }
    ) as { data?: { avatar?: string } };
    return json?.data?.avatar || null;
  } catch { return null; }
}

async function fetchBingxAvatar(id: string): Promise<string | null> {
  try {
    const json = await fetchJSON(
      `https://bingx.com/api/copyTrade/v1/trader/detail?uid=${id}`,
      { Origin: 'https://bingx.com', Referer: 'https://bingx.com/en/copy-trading/' }
    ) as { data?: { avatar?: string; headUrl?: string } };
    return json?.data?.avatar || json?.data?.headUrl || null;
  } catch { return null; }
}

// ---- Config ----
type Fetcher = (id: string) => Promise<string | null>;

const SOURCE_FETCHERS: Record<string, { fetcher: Fetcher; delayMs: number; concurrency: number }> = {
  binance_futures: { fetcher: fetchBinanceFuturesAvatar, delayMs: 200, concurrency: 5 },
  binance_spot:    { fetcher: fetchBinanceSpotAvatar,    delayMs: 200, concurrency: 5 },
  mexc:            { fetcher: fetchMexcAvatar,           delayMs: 300, concurrency: 3 },
  bybit:           { fetcher: fetchBybitAvatar,          delayMs: 300, concurrency: 3 },
  bybit_spot:      { fetcher: fetchBybitAvatar,          delayMs: 300, concurrency: 3 },
  kucoin:          { fetcher: fetchKucoinAvatar,         delayMs: 300, concurrency: 3 },
  coinex:          { fetcher: fetchCoinexAvatar,         delayMs: 300, concurrency: 3 },
  bitget_futures:  { fetcher: fetchBitgetAvatar,         delayMs: 300, concurrency: 3 },
  bitget_spot:     { fetcher: fetchBitgetAvatar,         delayMs: 300, concurrency: 3 },
  weex:            { fetcher: fetchWeexAvatar,           delayMs: 300, concurrency: 3 },
  bingx:           { fetcher: fetchBingxAvatar,          delayMs: 300, concurrency: 3 },
};

async function backfillSource(client: pg.Client, source: string, config: { fetcher: Fetcher; delayMs: number; concurrency: number }) {
  const { rows } = await client.query(
    `SELECT id, source_trader_id FROM trader_sources WHERE source=$1 AND avatar_url IS NULL`,
    [source]
  );
  if (!rows.length) {
    console.log(`[${source}] 0 missing — skip`);
    return { source, total: 0, updated: 0, failed: 0 };
  }
  console.log(`[${source}] ${rows.length} missing avatars`);

  let updated = 0, failed = 0;
  for (let i = 0; i < rows.length; i += config.concurrency) {
    const batch = rows.slice(i, i + config.concurrency);
    const results = await Promise.all(batch.map(async (row) => {
      const avatar = await config.fetcher(row.source_trader_id);
      return { id: row.id, avatar };
    }));

    for (const { id, avatar } of results) {
      if (avatar && !avatar.includes('dicebear') && !avatar.includes('identicon') && !avatar.includes('ui-avatars')) {
        await client.query(`UPDATE trader_sources SET avatar_url=$1 WHERE id=$2`, [avatar, id]);
        updated++;
      } else {
        failed++;
      }
    }

    if ((i + config.concurrency) % 50 < config.concurrency) {
      console.log(`  [${source}] ${i + batch.length}/${rows.length} — updated=${updated} failed=${failed}`);
    }
    await sleep(config.delayMs);
  }

  console.log(`[${source}] Done: updated=${updated} failed=${failed}/${rows.length}`);
  return { source, total: rows.length, updated, failed };
}

async function main() {
  // Allow filtering: npx tsx scripts/backfill-avatars-all.ts binance_futures mexc
  const filterSources = process.argv.slice(2);

  const client = new Client({ connectionString: DB });
  await client.connect();

  console.log('=== Avatar Backfill (All Sources) ===\n');

  const results: Array<{ source: string; total: number; updated: number; failed: number }> = [];

  for (const [source, config] of Object.entries(SOURCE_FETCHERS)) {
    if (filterSources.length && !filterSources.includes(source)) continue;
    const r = await backfillSource(client, source, config);
    results.push(r);
  }

  // Final stats
  console.log('\n=== Summary ===');
  const { rows: finalStats } = await client.query(`
    SELECT source, COUNT(*) as total, COUNT(avatar_url) as has_avatar,
           ROUND(COUNT(avatar_url)::numeric/COUNT(*)::numeric*100,1) as pct
    FROM trader_sources GROUP BY source ORDER BY total DESC
  `);
  console.table(finalStats);

  const overall = await client.query(`
    SELECT COUNT(*) as total, COUNT(avatar_url) as has_avatar,
           ROUND(COUNT(avatar_url)::numeric/COUNT(*)::numeric*100,1) as pct
    FROM trader_sources
  `);
  console.log(`\nOverall: ${overall.rows[0].has_avatar}/${overall.rows[0].total} (${overall.rows[0].pct}%)`);

  await client.end();
}

main().catch(console.error);
