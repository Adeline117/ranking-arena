/**
 * Find library_items where source_url points to a PDF and update pdf_url accordingly.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

async function main() {
  console.log('Scanning source_url for PDF links...')

  let updated = 0
  let scanned = 0
  let offset = 0
  const BATCH = 1000

  while (true) {
    const { data, error } = await supabase
      .from('library_items')
      .select('id, source_url')
      .is('pdf_url', null)
      .not('source_url', 'is', null)
      .range(offset, offset + BATCH - 1)

    if (error) { console.error(error.message); break }
    if (!data || data.length === 0) break

    const pdfItems = data.filter(item => {
      const url = (item.source_url || '').toLowerCase()
      return url.endsWith('.pdf') || url.includes('.pdf?') || url.includes('/pdf/') || url.includes('type=pdf')
    })

    if (pdfItems.length > 0) {
      for (const item of pdfItems) {
        const { error: ue } = await supabase
          .from('library_items')
          .update({ pdf_url: item.source_url })
          .eq('id', item.id)
        if (ue) console.error(`  Error updating ${item.id}: ${ue.message}`)
        else updated++
      }
    }

    scanned += data.length
    if (scanned % 5000 === 0) console.log(`  Scanned: ${scanned}, Updated: ${updated}`)
    offset += BATCH
    if (data.length < BATCH) break
  }

  console.log(`Done. Scanned: ${scanned}, Updated pdf_url: ${updated}`)
}

main().catch(console.error)
