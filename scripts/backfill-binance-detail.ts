import pg from 'pg';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
const { Client } = pg;

const DB = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres';

async function fetchOne(id: string): Promise<{ nickname: string; avatarUrl: string | null } | null> {
  try {
    const { stdout } = await execAsync(
      `curl -s --max-time 8 -x http://127.0.0.1:7890 --compressed 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${id}' -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' -H 'Origin: https://www.binance.com' -H 'Referer: https://www.binance.com/en/copy-trading'`,
      { timeout: 12000 }
    );
    const json = JSON.parse(stdout);
    if (json?.data?.nickname) {
      return { nickname: json.data.nickname, avatarUrl: json.data.avatarUrl || null };
    }
  } catch {}
  return null;
}

async function main() {
  const client = new Client({ connectionString: DB });
  await client.connect();

  const { rows } = await client.query(
    `SELECT id, source_trader_id FROM trader_sources WHERE source='binance_futures' AND handle IS NULL`
  );
  console.log(`Found ${rows.length} Binance futures traders with NULL handle`);

  let updated = 0, skipped = 0;
  const CONCURRENCY = 50;

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (row) => {
        const info = await fetchOne(row.source_trader_id);
        return { row, info };
      })
    );

    for (const { row, info } of results) {
      if (info) {
        await client.query(
          `UPDATE trader_sources SET handle=$1, avatar_url=COALESCE($2, avatar_url) WHERE id=$3`,
          [info.nickname, info.avatarUrl, row.id]
        );
        updated++;
      } else {
        skipped++;
      }
    }

    if ((i + CONCURRENCY) % 100 < CONCURRENCY) {
      console.log(`Progress: ${Math.min(i + CONCURRENCY, rows.length)}/${rows.length} | updated=${updated} skipped=${skipped}`);
    }
    
    // Small delay between batches
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\nDone! updated=${updated} skipped=${skipped}`);
  await client.end();
}

main().catch(console.error);
