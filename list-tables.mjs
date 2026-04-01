import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(url, key)

// List all tables
const { data, error } = await supabase.rpc('exec_sql', {
  query: `
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND table_name LIKE '%health%' OR table_name LIKE '%pipeline%'
    ORDER BY table_name
  `
})

if (error) {
  console.error('Error:', error)
  console.log('\nTrying alternative method...')
  
  // Try listing some common tables
  const tables = ['pipeline_metrics', 'health_checks', 'cron_logs', 'fetch_logs']
  for (const table of tables) {
    const { error } = await supabase.from(table).select('*').limit(1)
    if (!error) {
      console.log(`✓ Found table: ${table}`)
    }
  }
} else {
  console.log('Tables:', data)
}
