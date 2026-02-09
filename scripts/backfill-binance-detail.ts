import pg from 'pg';
const { Client } = pg;

const DB = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres';
const PROXY = 'http://127.0.0.1:7890';

async function main() {
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  const agent = new HttpsProxyAgent(PROXY);

  const client = new Client({ connectionString: DB });
  await client.connect();

  const { rows } = await client.query(
    `SELECT id, source_trader_id FROM trader_sources WHERE source='binance_futures' AND handle IS NULL`
  );
  console.log(`Found ${rows.length} Binance futures traders with NULL handle`);

  let updated = 0, skipped = 0, errors = 0;

  for (let i = 0; i < rows.length; i++) {
    const { id, source_trader_id } = rows[i];
    try {
      const url = `https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${source_trader_id}`;
      const resp = await fetch(url, {
        // @ts-ignore
        agent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Origin': 'https://www.binance.com',
          'Referer': 'https://www.binance.com/en/copy-trading',
        },
      });

      if (!resp.ok) { skipped++; continue; }
      const json = await resp.json() as any;
      const data = json?.data;
      if (!data?.nickname) { skipped++; continue; }

      await client.query(
        `UPDATE trader_sources SET handle=$1, avatar_url=COALESCE($2, avatar_url) WHERE id=$3`,
        [data.nickname, data.avatarUrl || null, id]
      );
      updated++;
    } catch (e: any) {
      errors++;
      if (errors <= 5) console.error(`Error for ${source_trader_id}: ${e.message}`);
    }

    if ((i + 1) % 50 === 0) {
      console.log(`Progress: ${i + 1}/${rows.length} | updated=${updated} skipped=${skipped} errors=${errors}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nDone! updated=${updated} skipped=${skipped} errors=${errors}`);
  await client.end();
}

main().catch(console.error);
