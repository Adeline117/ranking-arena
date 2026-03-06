import pg from 'pg';
const { Client } = pg;

const DB = process.env.DATABASE_URL;

async function main() {
  const client = new Client({ connectionString: DB });
  await client.connect();

  // Check what's left
  const { rows } = await client.query(
    `SELECT source, COUNT(*) as cnt FROM trader_sources WHERE handle IS NULL GROUP BY source ORDER BY cnt DESC`
  );
  console.log('Remaining NULL handles:', rows);

  // Delete all remaining NULL handle records (stale data)
  const { rowCount } = await client.query(
    `DELETE FROM trader_sources WHERE handle IS NULL`
  );
  console.log(`Deleted ${rowCount} remaining stale records with NULL handles`);

  // Final verification
  const { rows: check } = await client.query(
    `SELECT COUNT(*) as cnt FROM trader_sources WHERE handle IS NULL`
  );
  console.log(`Final NULL handle count: ${check[0].cnt}`);

  await client.end();
}

main().catch(console.error);
