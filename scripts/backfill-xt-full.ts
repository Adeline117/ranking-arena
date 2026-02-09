import pg from 'pg';
const { Client } = pg;

const DB = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres';

async function fetchAllXT(): Promise<Map<string, { nickName: string; avatar: string | null }>> {
  const traders = new Map<string, { nickName: string; avatar: string | null }>();
  const days = [7, 30, 90];

  // The API returns ALL sortTypes in each call with 3 items each
  // Paginate through to collect as many unique traders as possible
  // Stop when we see no new traders for 10 consecutive pages
  for (const d of days) {
    let page = 1;
    let noNewCount = 0;
    while (noNewCount < 10 && page <= 200) {
      const url = `https://www.xt.com/fapi/user/v1/public/copy-trade/elite-leader-list-v2?sortType=INCOME_RATE&days=${d}&page=${page}&pageSize=50`;
      try {
        const resp = await fetch(url);
        const json = await resp.json() as any;
        const resultArr = json?.result || [];
        let newThisPage = 0;
        for (const r of resultArr) {
          const items = r.items || [];
          for (const t of items) {
            const id = String(t.accountId);
            if (id && t.nickName && !traders.has(id)) {
              traders.set(id, { nickName: t.nickName, avatar: t.avatar || null });
              newThisPage++;
            }
          }
        }
        if (newThisPage === 0) noNewCount++;
        else noNewCount = 0;
        
        if (page % 20 === 0) console.log(`XT d=${d} p=${page}: total unique=${traders.size}`);
        page++;
      } catch (e: any) {
        console.error(`XT fetch error: ${e.message}`);
        break;
      }
      await new Promise(r => setTimeout(r, 300));
    }
    console.log(`XT d=${d} done after ${page-1} pages, total unique: ${traders.size}`);
  }
  return traders;
}

async function main() {
  const client = new Client({ connectionString: DB });
  await client.connect();

  console.log('Fetching XT leaderboard...');
  const xtTraders = await fetchAllXT();
  console.log(`\nFetched ${xtTraders.size} unique XT traders from API`);

  const { rows } = await client.query(
    `SELECT id, source_trader_id FROM trader_sources WHERE source='xt' AND handle IS NULL`
  );
  console.log(`DB has ${rows.length} XT traders with NULL handle`);

  let matched = 0;
  const unmatchedIds: number[] = [];

  for (const row of rows) {
    const info = xtTraders.get(row.source_trader_id);
    if (info) {
      await client.query(
        `UPDATE trader_sources SET handle=$1, avatar_url=COALESCE($2, avatar_url) WHERE id=$3`,
        [info.nickName, info.avatar, row.id]
      );
      matched++;
    } else {
      unmatchedIds.push(row.id);
    }
  }

  console.log(`Matched: ${matched}, Unmatched: ${unmatchedIds.length}`);

  // Delete unmatched stale records in batches
  if (unmatchedIds.length > 0) {
    let deleted = 0;
    const batchSize = 500;
    for (let i = 0; i < unmatchedIds.length; i += batchSize) {
      const batch = unmatchedIds.slice(i, i + batchSize);
      const { rowCount } = await client.query(`DELETE FROM trader_sources WHERE id = ANY($1)`, [batch]);
      deleted += rowCount || 0;
    }
    console.log(`Deleted ${deleted} stale XT records`);
  }

  console.log(`\nDone! matched=${matched} deleted=${unmatchedIds.length}`);
  await client.end();
}

main().catch(console.error);
