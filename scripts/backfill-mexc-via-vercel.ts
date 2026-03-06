import pg from 'pg';
const { Client } = pg;

const DB = process.env.DATABASE_URL;

async function main() {
  const client = new Client({ connectionString: DB });
  await client.connect();

  // Trigger Vercel scraper for each period
  for (const period of ['7D', '30D', '90D']) {
    console.log(`Triggering MEXC scrape for ${period}...`);
    try {
      const resp = await fetch(`https://www.arenafi.org/api/scrape/mexc?period=${period}`, { signal: AbortSignal.timeout(120000) });
      const json = await resp.json() as any;
      console.log(`MEXC ${period}: status=${resp.status}`, JSON.stringify(json).slice(0, 200));
    } catch (e: any) {
      console.error(`MEXC ${period} error: ${e.message}`);
    }
  }

  // Check remaining NULL handles
  const { rows } = await client.query(
    `SELECT COUNT(*) as cnt FROM trader_sources WHERE source='mexc' AND handle IS NULL`
  );
  const remaining = parseInt(rows[0].cnt);
  console.log(`MEXC remaining NULL handles: ${remaining}`);

  if (remaining > 0) {
    console.log(`Deleting ${remaining} stale MEXC records...`);
    const { rowCount } = await client.query(
      `DELETE FROM trader_sources WHERE source='mexc' AND handle IS NULL`
    );
    console.log(`Deleted ${rowCount} MEXC records`);
  }

  await client.end();
}

main().catch(console.error);
