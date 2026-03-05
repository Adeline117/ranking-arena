#!/usr/bin/env node
/**
 * Batch assign DiceBear generated covers to non-book items.
 * These are deterministic SVG covers based on title hash.
 * Fast — no API calls needed, just DB updates.
 */
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
)

const APPLY = process.argv.includes('--apply')
const BATCH = 500

async function main() {
  console.log(`=== DiceBear Cover Generation ${APPLY ? '' : '(DRY RUN)'} ===\n`)
  
  let offset = 0
  let total = 0

  while (true) {
    const { data, error } = await sb
      .from('library_items')
      .select('id, title, category')
      .is('cover_url', null)
      .order('id')
      .range(offset, offset + BATCH - 1)

    if (error) { console.error(error.message); break }
    if (!data || data.length === 0) break

    const updates = data.map(item => {
      const seed = encodeURIComponent((item.title || 'untitled').slice(0, 60))
      const bg = item.category === 'book' 
        ? '1e3a5f,312e81' 
        : item.category === 'paper' 
          ? '0f172a,1e293b'
          : '3b0764,581c87'
      return {
        id: item.id,
        cover_url: `https://api.dicebear.com/7.x/shapes/svg?seed=${seed}&size=300&backgroundColor=${bg}`
      }
    })

    if (APPLY) {
      for (const u of updates) {
        await sb.from('library_items').update({ cover_url: u.cover_url }).eq('id', u.id)
      }
    }

    total += updates.length
    offset += BATCH
    process.stdout.write(`\r  ${total} items processed`)
    
    if (data.length < BATCH) break
  }

  console.log(`\n\nDone: ${total} items ${APPLY ? 'updated' : '(dry run)'}`)
}

main().catch(console.error)
