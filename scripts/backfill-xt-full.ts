import pg from 'pg';
const { Client } = pg;

const DB = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres';

interface XTTrader { accountId: string; nickName: string; }

async function fetchAllXT(): Promise<Map<string, string>> {
  const traders = new Map<string, string>();
  const sortTypes = ['INCOME_RATE', 'FOLLOWER_COUNT', 'INCOME', 'FOLLOWER_PROFIT'];
  const days = [7, 30, 90];

  for (const sortType of sortTypes) {
    for (const d of days) {
      let page = 1;
      while (true) {
        const url = `https://www.xt.com/fapi/user/v1/public/copy-trade/elite-leader-list-v2?sortType=${sortType}&days=${d}&page=${page}&pageSize=50`;
        try {
          const resp = await fetch(url);
          const json = await resp.json() as any;
          const list = json?.result?.data || json?.data || [];
          if (!Array.isArray(list) || list.length === 0) break;
          for (const t of list) {
            const id = String(t.accountId || t.userId);
            if (id && t.nickName) traders.set(id, t.nickName);
          }
          console.log(`XT ${sortType} d=${d} p=${page}: ${list.length} traders (total unique: ${traders.size})`);
          page++;
        } catch (e: any) {
          console.error(`XT fetch error: ${e.message}`);
          break;
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
  return traders;
}

async function main() {
  const client = new Client({ connectionString: DB });
  await client.connect();

  console.log('Fetching XT leaderboard...');
  const xtTraders = await fetchAllXT();
  console.log(`Fetched ${xtTraders.size} unique XT traders`);

  // Get all XT records with NULL handle
  const { rows } = await client.query(
    `SELECT id, source_trader_id FROM trader_sources WHERE source='xt' AND handle IS NULL`
  );
  console.log(`DB has ${rows.length} XT traders with NULL handle`);

  let matched = 0, deleted = 0;
  const unmatchedIds: number[] = [];

  for (const row of rows) {
    const nickname = xtTraders.get(row.source_trader_id);
    if (nickname) {
      await client.query(`UPDATE trader_sources SET handle=$1 WHERE id=$2`, [nickname, row.id]);
      matched++;
    } else {
      unmatchedIds.push(row.id);
    }
  }

  // Delete unmatched (stale) records
  if (unmatchedIds.length > 0) {
    // First check if they have snapshots referencing them
    const { rowCount } = await client.query(
      `DELETE FROM trader_sources WHERE id = ANY($1)`,
      [unmatchedIds]
    );
    deleted = rowCount || 0;
  }

  console.log(`\nDone! matched=${matched} deleted=${deleted}`);
  await client.end();
}

main().catch(console.error);
