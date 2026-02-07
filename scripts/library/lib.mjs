// Shared helpers for library collection scripts
import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'

export function getClient() {
  return new pg.Client({ connectionString: DATABASE_URL })
}

export async function upsertItems(client, items, source) {
  let inserted = 0, skipped = 0
  for (const item of items) {
    try {
      await client.query(`
        INSERT INTO library_items (title, title_en, author, description, category, subcategory, source, source_url, pdf_url, cover_url, language, tags, crypto_symbols, publish_date, isbn, doi, is_free, buy_url)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT DO NOTHING
      `, [
        item.title, item.title_en || null, item.author || null, item.description || null,
        item.category, item.subcategory || null, source, item.source_url || null,
        item.pdf_url || null, item.cover_url || null, item.language || 'en',
        item.tags || null, item.crypto_symbols || null, item.publish_date || null,
        item.isbn || null, item.doi || null, item.is_free !== false, item.buy_url || null
      ])
      inserted++
    } catch (e) {
      if (e.code === '23505') skipped++ // unique violation
      else console.error(`Error inserting "${item.title}":`, e.message)
    }
  }
  console.log(`[${source}] Inserted: ${inserted}, Skipped: ${skipped}`)
  return { inserted, skipped }
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
