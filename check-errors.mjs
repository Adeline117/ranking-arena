import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(url, key)

console.log('=== Pipeline Error Details ===\n')

// Get error metrics from last 24h
const { data, error } = await supabase
  .from('pipeline_metrics')
  .select('*')
  .eq('metric_type', 'fetch_error')
  .gte('created_at', new Date(Date.now() - 24*60*60*1000).toISOString())
  .order('created_at', { ascending: false })
  .limit(50)

if (error) {
  console.error('Error:', error)
  process.exit(1)
}

console.log(`Found ${data.length} errors in last 24h\n`)

// Group by source and show recent errors
const bySource = {}
data.forEach(e => {
  if (!bySource[e.source]) {
    bySource[e.source] = []
  }
  bySource[e.source].push({
    time: e.created_at,
    error: e.metadata?.error || 'unknown',
    metadata: e.metadata
  })
})

Object.entries(bySource)
  .sort((a, b) => b[1].length - a[1].length)
  .forEach(([source, errors]) => {
    console.log(`\n━━━ ${source} (${errors.length} errors) ━━━`)
    errors.slice(0, 3).forEach((e, i) => {
      console.log(`\n${i+1}. [${new Date(e.time).toLocaleString()}]`)
      console.log(`Error: ${e.error}`)
      if (e.metadata && Object.keys(e.metadata).length > 1) {
        console.log(`Metadata:`, JSON.stringify(e.metadata, null, 2))
      }
    })
  })
