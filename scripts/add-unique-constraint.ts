/**
 * Add unique constraint on leaderboard_ranks(season_id, source, source_trader_id)
 * This prevents duplicate rows and makes upsert work correctly.
 * Run: npx tsx scripts/add-unique-constraint.ts
 */
import pg from 'pg'
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../.env.local') })

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  try {
    // Check existing constraints
    const { rows: existing } = await client.query(`
      SELECT indexname, indexdef FROM pg_indexes 
      WHERE tablename='leaderboard_ranks' AND indexdef LIKE '%UNIQUE%'
    `)
    console.log('Existing unique indexes:', existing)

    // Check remaining dupes
    const { rows: dupes } = await client.query(`
      SELECT source, source_trader_id, season_id, count(*) as cnt 
      FROM leaderboard_ranks 
      GROUP BY source, source_trader_id, season_id 
      HAVING count(*) > 1 
      LIMIT 20
    `)
    console.log(`Remaining duplicates: ${dupes.length}`)
    if (dupes.length > 0) {
      console.log('Sample dupes:', dupes.slice(0, 5))
      
      // Clean up remaining dupes before adding constraint
      console.log('Cleaning up all remaining duplicates...')
      const { rowCount } = await client.query(`
        DELETE FROM leaderboard_ranks 
        WHERE id NOT IN (
          SELECT DISTINCT ON (season_id, source, source_trader_id) id 
          FROM leaderboard_ranks 
          ORDER BY season_id, source, source_trader_id, updated_at DESC
        )
      `)
      console.log(`Deleted ${rowCount} duplicate rows`)
    }

    // Add unique constraint
    console.log('Adding unique constraint...')
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_leaderboard_ranks_season_source_trader 
      ON leaderboard_ranks (season_id, source, source_trader_id)
    `)
    console.log('✅ Unique constraint added successfully')

    // Verify
    const { rows: verify } = await client.query(`
      SELECT indexname, indexdef FROM pg_indexes 
      WHERE tablename='leaderboard_ranks' AND indexdef LIKE '%UNIQUE%'
    `)
    console.log('Verified unique indexes:', verify)
  } finally {
    await client.end()
  }
}

main().catch(console.error)
